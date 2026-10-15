/**
 * Cloud layer — Supabase for accounts (username + email/password), profiles,
 * the server-authoritative G economy (RPCs), saved characters/progress, and
 * Realtime presence/broadcast for seeing other players in the city.
 *
 * Runs in "offline practice" mode (localStorage only) when VITE_SUPABASE_* are
 * not set. Only the anon / publishable key may ever reach this bundle; secret
 * keys are refused outright (same rule as CrushlyApp/src/lib/env.ts).
 */
import { createClient, type RealtimeChannel, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { Appearance } from '../game/appearance';
import { type PlayerState, levelFor } from '../game/state';

function jwtRole(key: string): string | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).role ?? null; } catch { return null; }
}
export function isSecretKey(key: string) {
  return key.startsWith('sb_secret_') || jwtRole(key) === 'service_role';
}

function normalizeUrl(raw: string) {
  const v = raw.trim().replace(/^['"]+|['"]+$/g, '');
  if (!v) return '';
  try { return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).origin; } catch { return ''; }
}

export type Pose = 'none' | 'sit' | 'sleep';
export interface RemoteState { id: string; name: string; username: string; appearance: Appearance; x: number; z: number; yaw: number; speed: number; indoor: boolean; pose: Pose }
export interface LeaderRow { name: string; username?: string; popularity: number; level: number; cash: number; you?: boolean }
export interface Profile {
  id: string; username: string; display_name: string; bio: string; avatar_url: string | null;
  role: 'player' | 'official' | 'moderator' | 'admin'; status: 'active' | 'suspended' | 'banned';
  age_confirmed: boolean; character_ready: boolean; created_at: string;
}
export interface PublicProfile { id: string; username: string; display_name: string; bio: string; avatar_url: string | null; created_at: string; level: number; popularity: number }
export interface MeData { profile: Profile | null; balance: number; inventory: string[]; state: unknown; currency: { code: string; symbol: string; name: string } }
export interface MoneyResult { ok: boolean; error?: string; balance?: number; replay?: boolean; effects?: Record<string, number>; paid?: number; retry_in?: number; tx?: number }
export interface SignUpInput { username: string; displayName: string; email: string; password: string; tos: boolean; privacy: boolean; age: boolean }

export type CloudStatus = 'offline' | 'connecting' | 'guest' | 'signed-in' | 'error';

/** True inside the Capacitor Android app (served from https://localhost). */
export const isNativeApp = () => !!(window as any).Capacitor?.isNativePlatform?.() || location.hostname === 'localhost' && location.protocol === 'https:';
/** Where email links land. In the app the links open the hosted web build; in the browser, this page. */
export const webUrl = () => (isNativeApp() ? (import.meta.env.VITE_WEB_URL as string | undefined) || 'https://dyceelvk.github.io/Gistcity/' : location.href.split('#')[0].split('?')[0]);

/** Human-readable messages for the error codes raised by the database functions. */
export const ERROR_TEXT: Record<string, string> = {
  GC_INSUFFICIENT_FUNDS: "Your G balance doesn't reach. Go hustle small!",
  GC_ALREADY_OWNED: 'You already own that.',
  GC_UNKNOWN_ITEM: 'That item is not for sale.',
  GC_COOLDOWN: 'You just did that hustle — rest small and try again.',
  GC_PAYROLL_EMPTY: 'Government payroll is empty right now. Try again later.',
  GC_UNKNOWN_USER: 'No citizen with that username.',
  GC_SELF_TRANSFER: "You can't send G to yourself.",
  GC_UNKNOWN_ACCOUNT: 'That account cannot receive donations.',
  GC_ACCOUNT_RESTRICTED: 'Your account is restricted. Contact support.',
  GC_NOT_SIGNED_IN: 'Sign in to do that.',
  GC_KEY_REQUIRED: 'Request was malformed.',
  network: 'Network problem — nothing was charged. Try again.',
};
export const errorText = (code?: string) => (code && ERROR_TEXT[code]) || code || 'Something went wrong';

class Cloud {
  client: SupabaseClient | null = null;
  user: User | null = null;
  profile: Profile | null = null;
  status: CloudStatus = 'offline';
  error = '';
  private channel: RealtimeChannel | null = null;
  private saveTimer: number | null = null;
  onStatus: ((s: CloudStatus) => void) | null = null;
  onRemote: ((players: Map<string, RemoteState>) => void) | null = null;
  onWave: ((from: { id: string; name: string }) => void) | null = null;
  onRecovery: (() => void) | null = null;
  remote = new Map<string, RemoteState>();
  private lastSent = 0;
  private initialised = false;

  constructor() {
    const url = normalizeUrl(String(import.meta.env.VITE_SUPABASE_URL ?? ''));
    const key = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
    if (!url || !key) return;
    if (isSecretKey(key)) { console.error('[gist] Refusing to start with a secret Supabase key in the client bundle.'); this.status = 'error'; this.error = 'Secret key in client config'; return; }
    this.client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } });
  }

  get enabled() { return !!this.client; }
  get signedIn() { return this.status === 'signed-in' && !!this.user; }
  get email() { return this.user?.email ?? ''; }
  get emailVerified() { return !!this.user?.email_confirmed_at; }

  private setStatus(s: CloudStatus) { this.status = s; this.onStatus?.(s); }

  /**
   * Host-app bridge. When GIST runs inside the Crushly app's WebView, the app
   * can hand over its Supabase session so the player is the same account:
   *   webview.postMessage(JSON.stringify({ type: 'gist:session', access_token, refresh_token }))
   */
  installBridge() {
    const onMessage = async (evt: MessageEvent) => {
      let data: any = evt.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
      if (!data || data.type !== 'gist:session' || !this.client) return;
      if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') return;
      const { error } = await this.client.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
      if (error) console.warn('[gist] host session rejected:', error.message);
    };
    window.addEventListener('message', onMessage);
    document.addEventListener('message', onMessage as unknown as EventListener); // Android WebView delivers here
    this.toHost({ type: 'gist:ready', cloud: this.enabled });
  }
  toHost(msg: Record<string, unknown>) {
    const rn = (window as any).ReactNativeWebView;
    if (rn?.postMessage) rn.postMessage(JSON.stringify(msg));
  }

  /** Restore a persisted session (no anonymous sign-in: GistCity players register). */
  async init() {
    if (!this.client || this.initialised) return;
    this.initialised = true;
    this.setStatus('connecting');
    this.client.auth.onAuthStateChange((evt, session) => {
      const u = session?.user ?? null;
      this.user = u;
      if (evt === 'PASSWORD_RECOVERY') { this.onRecovery?.(); return; }
      if (u) { if (this.status !== 'signed-in') this.setStatus('signed-in'); }
      else { this.profile = null; this.leaveCity(); this.setStatus('guest'); }
    });
    const { data } = await this.client.auth.getSession();
    this.user = data.session?.user ?? null;
    this.setStatus(this.user ? 'signed-in' : 'guest');
  }

  /** Resolves once a user is signed in (used by the auth screen flow). */
  waitForSignIn(): Promise<User> {
    return new Promise((resolve) => {
      if (this.user) { resolve(this.user); return; }
      const prev = this.onStatus;
      this.onStatus = (s) => { prev?.(s); if (s === 'signed-in' && this.user) { this.onStatus = prev; resolve(this.user); } };
    });
  }

  /* ----------------------------------------------------------------- auth */

  async usernameAvailable(username: string): Promise<boolean> {
    if (!this.client) return true;
    const { data, error } = await this.client.rpc('username_available', { p: username.toLowerCase() });
    if (error) throw error;
    return !!data;
  }

  /** Returns true when the project requires email verification before the first sign-in. */
  async signUp(input: SignUpInput): Promise<{ needsVerification: boolean }> {
    if (!this.client) throw new Error('Cloud not configured');
    const { data, error } = await this.client.auth.signUp({
      email: input.email.trim(),
      password: input.password,
      options: {
        emailRedirectTo: webUrl(),
        data: {
          username: input.username.toLowerCase(),
          display_name: input.displayName.trim(),
          tos_accepted: input.tos, privacy_accepted: input.privacy, age_confirmed: input.age,
          tos_version: '2026-10-15',
        },
      },
    });
    if (error) throw error;
    // Supabase returns a user with an empty identities array when the email is already registered.
    if (data.user && Array.isArray((data.user as any).identities) && (data.user as any).identities.length === 0) {
      throw new Error('An account with this email already exists. Sign in instead.');
    }
    return { needsVerification: !data.session };
  }
  /** Confirm a new account with the 6-digit code from the verification email (works inside the Android app, no link needed). */
  async verifyEmailCode(email: string, code: string) {
    if (!this.client) throw new Error('Cloud not configured');
    let { error } = await this.client.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'signup' });
    if (error) ({ error } = await this.client.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' }));
    if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'That code is wrong or has expired. Request a new one.' : error.message);
  }
  /** Password reset with the 6-digit code from the reset email; returns once a session exists so updatePassword() can run. */
  async verifyRecoveryCode(email: string, code: string) {
    if (!this.client) throw new Error('Cloud not configured');
    const { error } = await this.client.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'recovery' });
    if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'That code is wrong or has expired. Request a new one.' : error.message);
  }
  async signIn(email: string, password: string) {
    if (!this.client) throw new Error('Cloud not configured');
    const { error } = await this.client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
  }
  async resendVerification(email: string) {
    if (!this.client) throw new Error('Cloud not configured');
    const { error } = await this.client.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: webUrl() } });
    if (error) throw error;
  }
  async resetPassword(email: string) {
    if (!this.client) throw new Error('Cloud not configured');
    const { error } = await this.client.auth.resetPasswordForEmail(email.trim(), { redirectTo: webUrl() });
    if (error) throw error;
  }
  async updatePassword(password: string) {
    if (!this.client) throw new Error('Cloud not configured');
    const { error } = await this.client.auth.updateUser({ password });
    if (error) throw error;
  }
  async signOut() { await this.client?.auth.signOut(); this.user = null; this.profile = null; }

  /* -------------------------------------------------------------- profile */

  async loadMe(): Promise<MeData> {
    const data = await this.rpc<MeData>('me', {});
    this.profile = data.profile;
    return data;
  }
  async setCharacterReady() {
    if (!this.client || !this.user) return;
    const { error } = await this.client.from('profiles').update({ character_ready: true }).eq('id', this.user.id);
    if (error) throw error;
    if (this.profile) this.profile.character_ready = true;
  }
  async updateProfile(patch: { display_name?: string; bio?: string }) {
    if (!this.client || !this.user) return;
    const { error } = await this.client.from('profiles').update(patch).eq('id', this.user.id);
    if (error) throw error;
    if (this.profile) Object.assign(this.profile, patch);
  }
  async publicProfile(id: string): Promise<PublicProfile | null> {
    if (!this.client) return null;
    const { data } = await this.client.from('public_profiles').select('*').eq('id', id).maybeSingle();
    return (data as PublicProfile | null) ?? null;
  }

  /* -------------------------------------------------------------- economy */

  /** Calls a database function; retries transient network failures (the idempotency key makes that safe). */
  async rpc<T>(fn: string, args: Record<string, unknown>, retries = 2): Promise<T> {
    if (!this.client) throw new Error('Cloud not configured');
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await this.client.rpc(fn, args);
      if (!error) return data as T;
      const transient = /fetch|network|timeout|50\d/i.test(error.message ?? '') && attempt < retries;
      if (!transient) { const e = new Error(error.message); (e as any).code = error.message; throw e; }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  purchase(itemId: string, key: string) { return this.rpc<MoneyResult>('purchase_item', { p_item: itemId, p_key: key }); }
  completeHustle(id: string, key: string) { return this.rpc<MoneyResult>('complete_hustle', { p_hustle: id, p_key: key }); }
  transfer(toUsername: string, amount: number, note: string, key: string) { return this.rpc<MoneyResult>('transfer_g', { p_to_username: toUsername, p_amount: amount, p_note: note, p_key: key }); }
  donate(code: string, amount: number, key: string) { return this.rpc<MoneyResult>('donate_g', { p_account_code: code, p_amount: amount, p_key: key }); }

  /* ----------------------------------------------------------------- save */

  /** Debounced save of the soft state (appearance, stats, needs, achievements…); `now` forces an immediate write. */
  save(state: PlayerState, now = false) {
    if (!this.client || !this.user) return Promise.resolve();
    if (this.saveTimer) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
    const doSave = async () => {
      if (!this.client || !this.user) return;
      const row = {
        id: this.user.id,
        display_name: state.name,
        appearance: state.appearance,
        state,
        cash: Math.min(2147483647, state.cash),
        popularity: state.stats.popularity,
        level: levelFor(state.stats.xp),
        updated_at: new Date().toISOString(),
      };
      const { error } = await this.client.from('gist_players').upsert(row);
      if (error) console.warn('[gist] save failed:', error.message);
    };
    if (now) return doSave();
    return new Promise<void>((resolve) => { this.saveTimer = window.setTimeout(() => { void doSave().then(resolve); }, 2500); });
  }

  async leaderboard(): Promise<LeaderRow[]> {
    if (!this.client) return [];
    const { data, error } = await this.client.from('gist_leaderboard').select('display_name,username,popularity,level,cash,id').limit(50);
    if (error || !data) return [];
    return data.map((r: any) => ({ name: r.display_name, username: r.username, popularity: r.popularity, level: r.level, cash: Number(r.cash), you: r.id === this.user?.id }));
  }

  /* ---------------------------------------------------------- realtime */

  joinCity(me: () => { name: string; username: string; appearance: Appearance }) {
    if (!this.client || !this.user || this.channel) return;
    const ch = this.client.channel('gist:city', { config: { presence: { key: this.user.id }, broadcast: { self: false, ack: false } } });
    this.channel = ch;
    ch.on('presence', { event: 'sync' }, () => {
      const st = ch.presenceState<{ name: string; username: string; appearance: Appearance }>();
      const seen = new Set<string>();
      for (const [id, metas] of Object.entries(st)) {
        if (id === this.user?.id) continue;
        seen.add(id);
        const m = metas[0];
        const prev = this.remote.get(id);
        if (prev) { prev.name = m.name; prev.username = m.username; prev.appearance = m.appearance; }
        else this.remote.set(id, { id, name: m.name, username: m.username ?? '', appearance: m.appearance, x: 0, z: 0, yaw: 0, speed: 0, indoor: true, pose: 'none' });
      }
      for (const id of [...this.remote.keys()]) if (!seen.has(id)) this.remote.delete(id);
      this.onRemote?.(this.remote);
    });
    ch.on('broadcast', { event: 'pos' }, ({ payload }) => {
      const p = payload as { id: string; x: number; z: number; yaw: number; s: number; in: boolean; p?: Pose };
      const r = this.remote.get(p.id);
      if (r) { r.x = p.x; r.z = p.z; r.yaw = p.yaw; r.speed = p.s; r.indoor = p.in; r.pose = p.p ?? 'none'; }
    });
    ch.on('broadcast', { event: 'wave' }, ({ payload }) => {
      const p = payload as { from: string; name: string; to: string };
      if (p.to === this.user?.id) this.onWave?.({ id: p.from, name: p.name });
    });
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await ch.track(me()); // also re-runs after an automatic reconnect
    });
  }
  async updatePresence(name: string, username: string, appearance: Appearance) { await this.channel?.track({ name, username, appearance }); }
  broadcastPos(x: number, z: number, yaw: number, speed: number, indoor: boolean, pose: Pose) {
    if (!this.channel || !this.user) return;
    const now = performance.now();
    if (now - this.lastSent < 120) return;
    this.lastSent = now;
    void this.channel.send({ type: 'broadcast', event: 'pos', payload: { id: this.user.id, x: +x.toFixed(2), z: +z.toFixed(2), yaw: +yaw.toFixed(2), s: speed, in: indoor, p: pose } });
  }
  wave(toId: string, myName: string) {
    if (!this.channel || !this.user) return;
    void this.channel.send({ type: 'broadcast', event: 'wave', payload: { from: this.user.id, name: myName, to: toId } });
  }
  leaveCity() { if (this.channel) { void this.client?.removeChannel(this.channel); this.channel = null; } this.remote.clear(); this.onRemote?.(this.remote); }
}

export const cloud = new Cloud();
