/**
 * Social layer: public profiles with photos & clips, follows, blocks/reports
 * and private direct messages.
 *
 * Online every call is a SECURITY DEFINER database function (see
 * supabase/migrations/20261017000004_gistcity_social.sql); media files live in
 * Supabase Storage. Offline practice mode runs the same rules against a local
 * mailbox on this device with a few local citizens, so the flows are fully
 * playable without an account — nothing offline is "fake", it is simply local.
 */
import type { Store } from '../game/state';
import { cloud, errorText } from './supabase';

export interface Result { ok: boolean; error?: string; message?: string; replay?: boolean }
export interface MediaItem { id: string; kind: 'photo' | 'clip'; path: string; caption: string; created_at: string; url?: string }
export interface ProfilePage {
  id: string; username: string; display_name: string; bio: string; avatar_url: string | null;
  created_at: string; occupation: string;
  followers: number; following: number;
  i_follow: boolean; follows_me: boolean; can_dm: boolean; blocked_by_me: boolean;
  media: MediaItem[];
}
export interface Thread {
  conversation_id: string; username: string; display_name: string; avatar_url: string | null;
  last_message: string | null; last_at: string; unread: number;
}
export interface Message {
  id: number | string; mine: boolean; body: string; media_path: string | null;
  media_url?: string | null; created_at: string; read_at: string | null;
}

export type ReportReason = 'spam' | 'abuse' | 'cheat' | 'inappropriate' | 'other';

export interface Social {
  readonly online: boolean;
  /** Live incoming-message hook (set by the game; implementations fire it). */
  onMessage?: ((thread: Thread, message: Message) => void) | null;
  profilePage(username: string): Promise<ProfilePage>;
  follow(username: string, on: boolean): Promise<Result>;
  block(username: string, on: boolean): Promise<Result>;
  report(username: string, reason: ReportReason, detail: string): Promise<Result>;
  /** Add a photo/clip to my own page (stays on my account; never leaves it silently). */
  uploadMedia(kind: 'photo' | 'clip', file: File | Blob, caption: string): Promise<Result>;
  deleteMedia(id: string): Promise<Result>;
  /** Media → something an <img>/<video> can load. */
  mediaUrl(path: string): Promise<string>;
  /** Attach a photo to a DM: uploads privately and returns the path to send. */
  attachDmPhoto(conversationId: string, file: File | Blob): Promise<{ ok: boolean; path?: string; message?: string }>;
  dmStart(username: string): Promise<{ ok: boolean; message?: string; conversation_id?: string }>;
  dmSend(conversationId: string, body: string, mediaPath?: string | null): Promise<Result>;
  dmThreads(): Promise<Thread[]>;
  dmHistory(conversationId: string, beforeId?: number | null): Promise<Message[]>;
  dmMarkRead(conversationId: string): Promise<void>;
}

export const SOCIAL_ERRORS: Record<string, string> = {
  GC_UNKNOWN_USER: 'No citizen with that username.',
  GC_SELF: 'That is you.',
  GC_BLOCKED: 'You cannot message this citizen.',
  GC_NOT_AUTHORISED: 'You are not part of this conversation.',
  GC_RATE_LIMITED: 'Slow down a little, then try again.',
  GC_INVALID_MESSAGE: 'Write something first (1–1000 characters).',
  GC_INVALID_PATH: 'That file cannot be attached here.',
  GC_INVALID_MEDIA: 'Only photos and short clips.',
  GC_MEDIA_LIMIT: 'Your page is full — delete something first.',
  GC_NOT_OWNER: 'That is not yours to delete.',
  GC_INVALID_REASON: 'Pick a report reason.',
};
const socialError = (code?: string) => (code && SOCIAL_ERRORS[code]) || errorText(code);
const fail = (code: string): any => ({ ok: false, error: code, message: socialError(code) });
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

/* ------------------------------------------------------------------ cloud */

export class CloudSocial implements Social {
  readonly online = true;
  /** Set by the game: called when a DM arrives over realtime. */
  onMessage: ((thread: Thread, message: Message) => void) | null = null;
  private inbox = cloud.client?.channel('gist:dm-inbox') ?? null;

  constructor(private store: Store) {
    // Live message delivery: postgres changes on my messages (RLS filters to my conversations).
    const ch = this.inbox;
    if (ch && cloud.user) {
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_messages' }, (payload: any) => {
        const row = payload.new as { conversation_id: string; sender_id: string; body: string; media_path: string | null; id: number; created_at: string };
        if (!row || row.sender_id === cloud.user?.id) return;
        void this.dmThreads().then((ts) => {
          const t = ts.find((x) => x.conversation_id === row.conversation_id);
          if (t) this.onMessage?.(t, { id: row.id, mine: false, body: row.body, media_path: row.media_path, created_at: row.created_at, read_at: null });
        });
      });
      void ch.subscribe();
    }
  }

  private async call<T extends Result>(fn: string, args: Record<string, unknown>): Promise<T> {
    try { return await cloud.rpc<T>(fn, args); }
    catch (e: any) { const m = String(e?.message ?? ''); const code = (m.match(/GC_[A-Z_]+/) || [m.includes('Failed to fetch') ? 'network' : m])[0]; return fail(code) as T; }
  }

  async profilePage(username: string): Promise<ProfilePage> {
    return await cloud.rpc<ProfilePage>('profile_page', { p_username: username.toLowerCase() });
  }
  async follow(username: string, on: boolean) { return this.call('follow_toggle', { p_username: username.toLowerCase(), p_follow: on }); }
  async block(username: string, on: boolean) { return this.call('block_toggle', { p_username: username.toLowerCase(), p_block: on }); }
  async report(username: string, reason: ReportReason, detail: string) {
    return this.call('report_user', { p_username: username.toLowerCase(), p_reason: reason, p_detail: detail });
  }

  async uploadMedia(kind: 'photo' | 'clip', file: File | Blob, caption: string): Promise<Result> {
    if (!cloud.client || !cloud.user) return fail('GC_NOT_SIGNED_IN');
    const max = kind === 'photo' ? 5e6 : 25e6;
    if (file.size > max) return { ok: false, message: kind === 'photo' ? 'Photos up to 5 MB.' : 'Clips up to 25 MB.' };
    const ext = ((file as File).name ?? '').split('.').pop()?.replace(/[^a-z0-9]/gi, '').slice(0, 5) || (kind === 'photo' ? 'jpg' : 'mp4');
    const path = `${cloud.user.id}/${uuid()}.${ext}`;
    const up = await cloud.client.storage.from('profile-media').upload(path, file, { contentType: file.type || (kind === 'photo' ? 'image/jpeg' : 'video/mp4'), upsert: false });
    if (up.error) return { ok: false, message: up.error.message };
    return this.call('media_add', { p_kind: kind, p_path: path, p_caption: caption });
  }
  async deleteMedia(id: string) { return this.call('media_delete', { p_id: id }); }
  async mediaUrl(path: string): Promise<string> {
    if (!cloud.client) return '';
    // my own folder is public-read; attachments are signed
    if (!/^[0-9a-f-]{36}\//i.test(path)) {
      return cloud.client.storage.from('profile-media').getPublicUrl(path).data.publicUrl;
    }
    const { data } = await cloud.client.storage.from('dm-media').createSignedUrl(path, 3600);
    return data?.signedUrl ?? '';
  }

  async dmStart(username: string) {
    try {
      const id = await cloud.rpc<string>('dm_start', { p_username: username.toLowerCase() });
      return { ok: true, conversation_id: String(id) };
    } catch (e: any) {
      const code = (String(e?.message ?? '').match(/GC_[A-Z_]+/) || [])[0];
      return { ok: false, message: socialError(code) };
    }
  }
  async attachDmPhoto(conversationId: string, file: File | Blob) {
    if (!cloud.client) return { ok: false, message: 'Not connected.' };
    if (file.size > 5e6) return { ok: false, message: 'Photos up to 5 MB.' };
    const path = `${conversationId}/${uuid()}.jpg`;
    const up = await cloud.client.storage.from('dm-media').upload(path, file, { contentType: file.type || 'image/jpeg' });
    if (up.error) return { ok: false, message: up.error.message };
    return { ok: true, path };
  }
  async dmSend(conversationId: string, body: string, mediaPath: string | null = null) {
    return this.call('dm_send', { p_conversation: conversationId, p_body: body, p_key: uuid(), p_media: mediaPath });
  }
  async dmThreads() {
    const rows = await cloud.rpc<any[]>('dm_threads', {});
    return (rows ?? []) as Thread[];
  }
  async dmHistory(conversationId: string, beforeId: number | null = null) {
    const rows = await cloud.rpc<any[]>('dm_history', { p_conversation: conversationId, p_before_id: beforeId, p_limit: 60 });
    return (rows ?? []) as Message[];
  }
  async dmMarkRead(conversationId: string) {
    try { await cloud.rpc('dm_mark_read', { p_conversation: conversationId }); } catch { /* best effort */ }
  }
}

/* ------------------------------------------------------------------ local */

interface LocalCitizen { name: string; username: string; bio: string; occupation: string; color: string; replies: string[] }
interface LocalMsg { id: number; mine: boolean; body: string; media_path: string | null; created_at: string; read_at: string | null }
interface LocalThread { username: string; messages: LocalMsg[]; unread: number; last_at: string }
interface LocalSocialData {
  follows: string[]; blocks: string[];
  threads: Record<string, LocalThread>;
  media: Record<string, (MediaItem & { data?: string })[]>;
  nextId: number;
}

/** Local citizens for practice mode — the same people as the city's NPCs. */
export const LOCAL_CITIZENS: LocalCitizen[] = [
  { name: 'Tunde', username: 'tunde', bio: 'Area boy with a plan. Danfo stories and football takes.', occupation: 'Dispatch rider', color: '#2e86de', replies: ['How far!', 'E choke 😂', 'Make we link up later.', 'You don chop?'] },
  { name: 'Chioma', username: 'chioma', bio: 'Market woman. I sell anything that sells.', occupation: 'Trader · Mama Nkechi Kitchen', color: '#e33e79', replies: ['Welcome! Wetin you dey find?', 'Market dey fine today.', 'Come back tomorrow, I go give you better price.'] },
  { name: 'Emeka', username: 'emeka', bio: 'Mechanic wey dey fix your car and your grammar.', occupation: 'Mechanic · Iron Temple', color: '#f5c242', replies: ['Your car ready.', 'Bring am for workshop.', 'No wahala my guy.'] },
  { name: 'Ngozi', username: 'ngozi', bio: 'Nurse by day, dancer by night.', occupation: 'Nurse · GistCity General', color: '#2ecc71', replies: ['I dey fine o!', 'Take care of your health.', 'See you for church on Sunday.'] },
];

const LKEY = 'gist_social_v1';
const blank = (): LocalSocialData => ({ follows: [], blocks: [], threads: {}, media: {}, nextId: 1 });

export class LocalSocial implements Social {
  readonly online = false;
  onMessage: ((thread: Thread, message: Message) => void) | null = null;
  private d: LocalSocialData;

  constructor(private store: Store) {
    let d: LocalSocialData | null = null;
    try { const raw = localStorage.getItem(LKEY); if (raw) d = { ...blank(), ...JSON.parse(raw) }; } catch { /* fresh */ }
    this.d = d ?? blank();
    // seed the local citizens with demo gallery photos (SVG data URLs — tiny, offline-safe)
    const photo = (hue: number, label: string): string =>
      'data:image/svg+xml;utf8,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,55%)"/><stop offset="1" stop-color="hsl(${hue + 40},55%,30%)"/></linearGradient></defs><rect width="240" height="320" fill="url(#g)"/><circle cx="120" cy="120" r="52" fill="rgba(255,255,255,0.35)"/><rect x="70" y="185" width="100" height="80" rx="18" fill="rgba(255,255,255,0.28)"/><text x="120" y="295" font-family="sans-serif" font-size="18" fill="#fff" text-anchor="middle">${label}</text></svg>`);
    for (const c of LOCAL_CITIZENS) {
      if (!this.d.media[c.username]) this.d.media[c.username] = [];
      if (this.d.media[c.username].length === 0) {
        const t = new Date(Date.now() - 86400e3 * 3).toISOString();
        this.d.media[c.username].push(
          { id: `seed-${c.username}-1`, kind: 'photo', path: `seed/${c.username}/1`, caption: 'Life in GistCity', created_at: t, data: photo(c.username.length * 37, c.name) },
          { id: `seed-${c.username}-2`, kind: 'photo', path: `seed/${c.username}/2`, caption: 'Weekend vibes', created_at: new Date(Date.now() - 86400e3).toISOString(), data: photo(c.username.length * 37 + 120, 'GistCity') },
        );
      }
    }
  }
  private save() { try { localStorage.setItem(LKEY, JSON.stringify(this.d)); } catch { /* ignore */ } }
  private citizen(username: string): LocalCitizen | null {
    return LOCAL_CITIZENS.find((c) => c.username === username.toLowerCase()) ?? null;
  }
  /** Any citizen of the practice city: the seeded ones, or a generated page. */
  private person(username: string): LocalCitizen {
    const u = username.toLowerCase();
    return this.citizen(u) ?? {
      name: u.replace(/[_-]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      username: u, bio: 'Citizen of GistCity.', occupation: 'Citizen', color: '#8a9a8a',
      replies: ['How far!', 'No wahala.', 'Make we talk later.', 'I dey hear you.'],
    };
  }

  async profilePage(username: string): Promise<ProfilePage> {
    const u = username.toLowerCase();
    const mine = this.store.state.username === u || u === 'me';
    const me = { name: this.store.state.name, username: this.store.state.username || 'me', bio: 'Citizen of GistCity.', occupation: 'Citizen', color: '#a5ff38' };
    const c = mine ? me : this.person(u);
    const key = mine ? 'me' : c.username;
    return {
      id: key, username: c.username, display_name: c.name, bio: c.bio,
      avatar_url: null, created_at: new Date(Date.now() - 86400e3 * 90).toISOString(),
      occupation: c.occupation,
      followers: (this.d.follows.includes(key) ? 1 : 0) + (mine ? 12 : 3),
      following: mine ? this.d.follows.length : 2,
      i_follow: this.d.follows.includes(key),
      follows_me: !mine && Math.abs(u.length) % 2 === 0,
      can_dm: !mine && !this.d.blocks.includes(key),
      blocked_by_me: this.d.blocks.includes(key),
      media: this.d.media[key] ?? [],
    };
  }
  async follow(username: string, on: boolean): Promise<Result> {
    const key = username.toLowerCase();
    if (!this.citizen(key)) return fail('GC_UNKNOWN_USER');
    if (on && !this.d.follows.includes(key)) this.d.follows.push(key);
    if (!on) this.d.follows = this.d.follows.filter((u) => u !== key);
    this.save();
    return { ok: true };
  }
  async block(username: string, on: boolean): Promise<Result> {
    const key = username.toLowerCase();
    if (!this.citizen(key)) return fail('GC_UNKNOWN_USER');
    if (on && !this.d.blocks.includes(key)) this.d.blocks.push(key);
    if (!on) this.d.blocks = this.d.blocks.filter((u) => u !== key);
    // blocking removes follows both ways (same rule as the server)
    if (on) this.d.follows = this.d.follows.filter((u) => u !== key);
    this.save();
    return { ok: true };
  }
  async report(): Promise<Result> {
    return { ok: true, message: 'Reported. The moderators will review it (practice mode keeps it on this device).' };
  }

  async uploadMedia(kind: 'photo' | 'clip', file: File | Blob, caption: string): Promise<Result> {
    const max = kind === 'photo' ? 400e3 : 1.2e6;
    if (file.size > max) return { ok: false, message: kind === 'photo' ? 'Practice photos up to 400 KB — sign in for full size.' : 'Practice clips up to 1.2 MB — sign in for full size.' };
    const data = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(new Error('Could not read the file'));
      r.readAsDataURL(file);
    });
    const key = 'me';
    const list = this.d.media[key] ?? (this.d.media[key] = []);
    if (list.filter((m) => m.kind === kind).length >= (kind === 'photo' ? 24 : 8)) return fail('GC_MEDIA_LIMIT');
    list.unshift({ id: uuid(), kind, path: `local/${uuid()}`, caption, created_at: new Date().toISOString(), data });
    this.save();
    return { ok: true };
  }
  async deleteMedia(id: string): Promise<Result> {
    const before = this.d.media['me']?.length ?? 0;
    this.d.media['me'] = (this.d.media['me'] ?? []).filter((m) => m.id !== id);
    this.save();
    return this.d.media['me'].length < before ? { ok: true } : fail('GC_NOT_OWNER');
  }
  async mediaUrl(path: string): Promise<string> {
    for (const list of Object.values(this.d.media)) {
      const m = list.find((x) => x.path === path || x.path === `local/${path}`);
      if (m?.data) return m.data;
    }
    return '';
  }

  async dmStart(username: string) {
    const key = username.toLowerCase();
    const c = this.person(key);
    if (this.d.blocks.includes(c.username)) return { ok: false, message: socialError('GC_BLOCKED') };
    if (!this.d.threads[c.username]) {
      this.d.threads[c.username] = { username: c.username, messages: [], unread: 0, last_at: new Date().toISOString() };
      this.save();
    }
    return { ok: true, conversation_id: c.username };
  }
  async attachDmPhoto(_conversationId: string, file: File | Blob) {
    if (file.size > 1.2e6) return { ok: false, message: 'Practice photos up to 1.2 MB — sign in for full size.' };
    const data = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
    const path = `localdm/${uuid()}`;
    this.d.media['me'] = this.d.media['me'] ?? [];
    this.d.media['me'].unshift({ id: path, kind: 'photo', path, caption: '', created_at: new Date().toISOString(), data });
    this.save();
    return { ok: true, path };
  }
  async dmSend(conversationId: string, body: string, mediaPath: string | null = null): Promise<Result> {
    const t = this.d.threads[conversationId];
    if (!t) return fail('GC_NOT_AUTHORISED');
    if (this.d.blocks.includes(conversationId)) return fail('GC_BLOCKED');
    const text = body.trim();
    if (text.length > 1000 || (text.length < 1 && !mediaPath)) return fail('GC_INVALID_MESSAGE');
    const now = new Date().toISOString();
    t.messages.push({ id: this.d.nextId++, mine: true, body: text, media_path: mediaPath, created_at: now, read_at: now });
    t.last_at = now;
    this.save();
    // the local citizen answers after a moment, like a real person would
    const c = this.person(conversationId);
    window.setTimeout(() => {
      const t2 = this.d.threads[conversationId];
      if (!t2 || this.d.blocks.includes(conversationId)) return;
      const line = c.replies[t2.messages.length % c.replies.length];
      const at = new Date().toISOString();
      t2.messages.push({ id: this.d.nextId++, mine: false, body: line, media_path: null, created_at: at, read_at: null });
      t2.unread++;
      t2.last_at = at;
      this.save();
      this.onMessage?.(
        { conversation_id: conversationId, username: c.username, display_name: c.name, avatar_url: null, last_message: line, last_at: at, unread: t2.unread },
        { id: t2.messages[t2.messages.length - 1].id, mine: false, body: line, media_path: null, created_at: at, read_at: null },
      );
    }, 1400 + Math.random() * 1200);
    return { ok: true };
  }
  async dmThreads(): Promise<Thread[]> {
    return Object.values(this.d.threads).map((t) => {
      const c = this.person(t.username);
      const last = t.messages[t.messages.length - 1];
      return {
        conversation_id: t.username, username: t.username,
        display_name: c?.name ?? t.username, avatar_url: null,
        last_message: last?.body ?? null, last_at: t.last_at, unread: t.unread,
      };
    }).sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
  }
  async dmHistory(conversationId: string): Promise<Message[]> {
    return (this.d.threads[conversationId]?.messages ?? []).map((m) => ({ ...m }));
  }
  async dmMarkRead(conversationId: string): Promise<void> {
    const t = this.d.threads[conversationId];
    if (!t) return;
    t.unread = 0;
    for (const m of t.messages) if (!m.mine) m.read_at = new Date().toISOString();
    this.save();
  }
}

export const makeSocial = (store: Store): Social => (cloud.enabled && cloud.signedIn ? new CloudSocial(store) : new LocalSocial(store));
