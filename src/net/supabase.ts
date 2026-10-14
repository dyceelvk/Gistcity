/**
 * Cloud layer — Supabase for accounts, saved characters and progress, and
 * Realtime for seeing other players in the city.
 *
 * Works fully offline (localStorage) when VITE_SUPABASE_* are not set.
 * Only the anon / publishable key may ever reach this bundle; secret keys are
 * refused outright (same rule as CrushlyApp/src/lib/env.ts).
 */
import { createClient, type RealtimeChannel, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { Appearance } from '../game/appearance';
import { sanitizeState, type PlayerState, levelFor } from '../game/state';

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

export interface RemoteState { id: string; name: string; appearance: Appearance; x: number; z: number; yaw: number; speed: number; indoor: boolean }
export interface LeaderRow { name: string; popularity: number; level: number; cash: number; you?: boolean }

export type CloudStatus = 'offline' | 'connecting' | 'guest' | 'signed-in' | 'error';

class Cloud {
  client: SupabaseClient | null = null;
  user: User | null = null;
  status: CloudStatus = 'offline';
  error = '';
  private channel: RealtimeChannel | null = null;
  private saveTimer: number | null = null;
  onStatus: ((s: CloudStatus) => void) | null = null;
  onRemote: ((players: Map<string, RemoteState>) => void) | null = null;
  onCloudState: ((s: PlayerState) => void) | null = null;
  remote = new Map<string, RemoteState>();
  private lastSent = 0;

  constructor() {
    const url = normalizeUrl(String(import.meta.env.VITE_SUPABASE_URL ?? ''));
    const key = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
    if (!url || !key) return;
    if (isSecretKey(key)) { console.error('[gist] Refusing to start with a secret Supabase key in the client bundle.'); this.status = 'error'; this.error = 'Secret key in client config'; return; }
    this.client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  }

  get enabled() { return !!this.client; }

  /**
   * Host-app bridge. When GIST runs inside the Crushly app's WebView, the app
   * can hand over its Supabase session so the player is the same account:
   *   webview.postMessage(JSON.stringify({ type: 'gist:session', access_token, refresh_token }))
   * GIST answers with { type: 'gist:ready' } / { type: 'gist:state', ... } via
   * window.ReactNativeWebView.postMessage.
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

  private setStatus(s: CloudStatus) { this.status = s; this.onStatus?.(s); }

  async init(local: PlayerState) {
    if (!this.client) return;
    this.setStatus('connecting');
    this.client.auth.onAuthStateChange((_evt, session) => {
      const u = session?.user ?? null;
      const changed = u?.id !== this.user?.id;
      this.user = u;
      if (u && changed) void this.afterSignIn(local);
      if (!u) { this.leaveCity(); this.setStatus('guest'); }
    });
    const { data } = await this.client.auth.getSession();
    if (data.session?.user) { this.user = data.session.user; await this.afterSignIn(local); return; }
    // Try an anonymous session so progress syncs immediately; falls back to guest.
    const { error } = await this.client.auth.signInAnonymously();
    if (error) { this.setStatus('guest'); }
  }

  private async afterSignIn(local: PlayerState) {
    if (!this.client || !this.user) return;
    this.setStatus('signed-in');
    const { data, error } = await this.client.from('gist_players').select('state').eq('id', this.user.id).maybeSingle();
    if (!error && data?.state) {
      this.onCloudState?.(sanitizeState(data.state));
    } else if (!error) {
      await this.save(local, true);
    }
  }

  get isAnonymous() { return !!this.user && (this.user as any).is_anonymous === true; }
  get email() { return this.user?.email ?? ''; }

  async signInWithEmail(email: string) {
    if (!this.client) throw new Error('Cloud not configured');
    const { error } = await this.client.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href.split('#')[0] } });
    if (error) throw error;
  }
  /** Upgrade an anonymous session to a real account so progress survives a new device. */
  async linkEmail(email: string) {
    if (!this.client) throw new Error('Cloud not configured');
    const { error } = await this.client.auth.updateUser({ email });
    if (error) throw error;
  }
  async signOut() { await this.client?.auth.signOut(); }

  /** Debounced save; `now` forces an immediate write. */
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
        cash: state.cash,
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
    const { data, error } = await this.client.from('gist_leaderboard').select('display_name,popularity,level,cash,id').limit(50);
    if (error || !data) return [];
    return data.map((r: any) => ({ name: r.display_name, popularity: r.popularity, level: r.level, cash: r.cash, you: r.id === this.user?.id }));
  }

  /* ---------------------------------------------------------- realtime */

  joinCity(me: () => { name: string; appearance: Appearance }) {
    if (!this.client || !this.user || this.channel) return;
    const ch = this.client.channel('gist:city', { config: { presence: { key: this.user.id }, broadcast: { self: false, ack: false } } });
    this.channel = ch;
    ch.on('presence', { event: 'sync' }, () => {
      const st = ch.presenceState<{ name: string; appearance: Appearance }>();
      const seen = new Set<string>();
      for (const [id, metas] of Object.entries(st)) {
        if (id === this.user?.id) continue;
        seen.add(id);
        const m = metas[0];
        const prev = this.remote.get(id);
        if (prev) { prev.name = m.name; prev.appearance = m.appearance; }
        else this.remote.set(id, { id, name: m.name, appearance: m.appearance, x: 0, z: 0, yaw: 0, speed: 0, indoor: true });
      }
      for (const id of [...this.remote.keys()]) if (!seen.has(id)) this.remote.delete(id);
      this.onRemote?.(this.remote);
    });
    ch.on('broadcast', { event: 'pos' }, ({ payload }) => {
      const p = payload as { id: string; x: number; z: number; yaw: number; s: number; in: boolean };
      const r = this.remote.get(p.id);
      if (r) { r.x = p.x; r.z = p.z; r.yaw = p.yaw; r.speed = p.s; r.indoor = p.in; }
    });
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await ch.track(me());
    });
  }
  async updatePresence(name: string, appearance: Appearance) { await this.channel?.track({ name, appearance }); }
  broadcastPos(x: number, z: number, yaw: number, speed: number, indoor: boolean) {
    if (!this.channel || !this.user) return;
    const now = performance.now();
    if (now - this.lastSent < 120) return;
    this.lastSent = now;
    void this.channel.send({ type: 'broadcast', event: 'pos', payload: { id: this.user.id, x: +x.toFixed(2), z: +z.toFixed(2), yaw: +yaw.toFixed(2), s: speed, in: indoor } });
  }
  leaveCity() { if (this.channel) { void this.client?.removeChannel(this.channel); this.channel = null; } this.remote.clear(); this.onRemote?.(this.remote); }
}

export const cloud = new Cloud();
