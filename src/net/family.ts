/**
 * Family & ageing: character cards, marriage with a signed agreement, the
 * abstract "family room" childbirth, and the daily birth registry.
 *
 * Online these are SECURITY DEFINER database functions (see
 * supabase/migrations/20261018000005_gistcity_family.sql). Offline practice
 * mode keeps the same rules in a local save on this device.
 */
import { ageYears, bornAtForAge } from '../game/family';
import type { Store } from '../game/state';
import { cloud, errorText } from './supabase';
import { LOCAL_CITIZENS } from './social';

export interface CharacterCard {
  id: string; name: string; gender: string | null;
  born_at: string; age: number; is_child: boolean;
}
export interface TreePerson { id: string; name: string; age: number; gender?: string | null; born_at?: string; username?: string }
export interface FamilyTree {
  self: TreePerson;
  spouse: TreePerson | null;
  children: TreePerson[];
  parents: { mother: TreePerson | null; father: TreePerson | null };
}
export interface Marriage {
  id: string; status: 'proposed' | 'active' | 'ended';
  agreement: string; partner: string;
  i_signed: boolean; partner_signed: boolean;
  created_at: string; activated_at?: string | null;
}
export interface BirthRecord {
  id: string; name: string; born_on: string; child_id: string;
  mother: string | null; father: string | null; registered_at: string;
}
export interface Result { ok: boolean; message?: string; error?: string; status?: string; marriage_id?: string; child_id?: string; name?: string }

export interface Family {
  readonly online: boolean;
  /** Sync age estimate (cached once loaded). */
  ageNow(): number;
  me(): Promise<CharacterCard>;
  tree(username?: string): Promise<FamilyTree>;
  marriages(): Promise<Marriage[]>;
  propose(partner: string, terms: string): Promise<Result>;
  sign(id: string): Promise<Result>;
  end(id: string, reason: string): Promise<Result>;
  /** The family room: abstract, non-explicit — enter, fade to black, a newborn is registered. */
  childbirth(marriageId: string, name: string): Promise<Result>;
  birthRegistry(day?: string): Promise<BirthRecord[]>;
}

export const FAMILY_ERRORS: Record<string, string> = {
  GC_SELF: 'You cannot marry yourself.',
  GC_UNKNOWN_USER: 'No citizen with that username.',
  GC_BLOCKED: 'You cannot propose to this citizen.',
  GC_TOO_YOUNG: 'Marriage is for adults (18+).',
  GC_ALREADY_MARRIED: 'One of you is already married.',
  GC_PROPOSAL_OPEN: 'You already have a proposal waiting.',
  GC_ALREADY_SIGNED: 'You already signed this agreement.',
  GC_NOT_OPEN: 'This agreement is closed.',
  GC_NOT_FOUND: 'That record was not found.',
  GC_NOT_AUTHORISED: 'This is not yours to sign.',
  GC_NOT_MARRIED: 'Only married couples can use the family room.',
  GC_NOT_ELIGIBLE_AGE: 'Childbearing years are 18–50.',
  GC_INVALID_NAME: 'Choose a name for the baby (1–24 characters).',
  GC_ALREADY_BORN_TODAY: 'One baby per couple per day — rest and come back tomorrow.',
  GC_RATE_LIMITED: 'Slow down a little, then try again.',
};
const familyError = (code?: string) => (code && FAMILY_ERRORS[code]) || errorText(code);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x'.repeat(8));

/* ------------------------------------------------------------------ cloud */

export class CloudFamily implements Family {
  readonly online = true;
  private cachedAge = 25;
  constructor() {
    void this.me().then((m) => { this.cachedAge = m.age; }).catch(() => { /* offline */ });
  }
  ageNow(): number { return this.cachedAge; }

  private async call<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
    try { return await cloud.rpc<T>(fn, args); }
    catch (e: any) {
      const code = (String(e?.message ?? '').match(/GC_[A-Z_]+/) ?? [])[0];
      throw Object.assign(new Error(familyError(code)), { code });
    }
  }
  private async ok(fn: string, args: Record<string, unknown>): Promise<Result> {
    try { const r = await this.call<any>(fn, args); return { ok: true, ...r }; }
    catch (e: any) { return { ok: false, error: e.code, message: e.message }; }
  }

  async me(): Promise<CharacterCard> { return this.call('character_me', {}); }
  async tree(username?: string): Promise<FamilyTree> { return this.call('family_tree', username ? { p_username: username } : {}); }
  async marriages(): Promise<Marriage[]> { return (await this.call<any[]>('marriages_mine', {})) ?? []; }
  propose(partner: string, terms: string) { return this.ok('marriage_propose', { p_partner: partner.toLowerCase(), p_terms: terms }); }
  sign(id: string) { return this.ok('marriage_sign', { p_marriage: id }); }
  end(id: string, reason: string) { return this.ok('marriage_end', { p_marriage: id, p_reason: reason }); }
  childbirth(marriageId: string, name: string) { return this.ok('childbirth', { p_marriage: marriageId, p_name: name }); }
  async birthRegistry(day?: string): Promise<BirthRecord[]> {
    return (await this.call<any[]>('birth_registry', day ? { p_on: day } : {})) ?? [];
  }
}

/* ------------------------------------------------------------------ local */

interface LocalMarriage extends Marriage { partner_username: string }
interface LocalChild { id: string; name: string; bornAt: string; mother: string; father: string }
interface LocalFamilyData {
  bornAt: number;
  marriages: LocalMarriage[];
  children: LocalChild[];
  lastBirthDay: string | null;
  proposalSeed: number;
}
const LKEY = 'gist_family_v1';

export class LocalFamily implements Family {
  readonly online = false;
  private d: LocalFamilyData;

  constructor(private store: Store) {
    let d: LocalFamilyData | null = null;
    try { const raw = localStorage.getItem(LKEY); if (raw) d = { ...JSON.parse(raw) }; } catch { /* fresh */ }
    this.d = d ?? { bornAt: bornAtForAge(18), marriages: [], children: [], lastBirthDay: null, proposalSeed: 1 };
  }
  private save() { try { localStorage.setItem(LKEY, JSON.stringify(this.d)); } catch { /* ignore */ } }
  private person(name: string) {
    return LOCAL_CITIZENS.find((c) => c.username === name.toLowerCase())
      ?? { name, username: name.toLowerCase(), bio: '', occupation: 'Citizen', color: '#888', replies: [] };
  }
  ageNow(): number { return ageYears(this.d.bornAt); }

  async me(): Promise<CharacterCard> {
    const age = this.ageNow();
    return {
      id: 'me', name: this.store.state.name, gender: null,
      born_at: new Date(this.d.bornAt).toISOString(), age, is_child: age < 18,
    };
  }
  async tree(username?: string): Promise<FamilyTree> {
    const active = this.d.marriages.find((m) => m.status === 'active');
    const spouse = active ? this.person(active.partner) : null;
    return {
      self: { id: 'me', name: this.store.state.name, age: this.ageNow(), gender: null, born_at: new Date(this.d.bornAt).toISOString(), username: this.store.state.username || 'me' },
      spouse: spouse ? { id: spouse.username, name: spouse.name, age: 28, gender: null } : null,
      children: this.d.children.map((c) => ({ id: c.id, name: c.name, age: ageYears(c.bornAt), born_at: c.bornAt, gender: null })),
      parents: { mother: null, father: null },
    };
  }
  async marriages(): Promise<Marriage[]> {
    return this.d.marriages.map(({ partner_username: _u, ...m }) => ({ ...m, partner: m.partner })).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  async propose(partner: string, terms: string): Promise<Result> {
    const p = this.person(partner);
    if (p.username === (this.store.state.username || 'me')) return { ok: false, message: familyError('GC_SELF') };
    if (this.ageNow() < 18) return { ok: false, message: familyError('GC_TOO_YOUNG') };
    if (this.d.marriages.some((m) => m.status === 'active')) return { ok: false, message: familyError('GC_ALREADY_MARRIED') };
    if (this.d.marriages.some((m) => m.status === 'proposed')) return { ok: false, message: familyError('GC_PROPOSAL_OPEN') };
    const m: LocalMarriage = {
      id: uuid(), status: 'proposed', agreement: terms.slice(0, 1000), partner: p.name, partner_username: p.username,
      i_signed: false, partner_signed: false, created_at: new Date().toISOString(), activated_at: null,
    };
    this.d.marriages.unshift(m);
    this.save();
    // the local partner reads the agreement and signs after a moment
    window.setTimeout(() => {
      const mm = this.d.marriages.find((x) => x.id === m.id);
      if (!mm || mm.status !== 'proposed') return;
      mm.partner_signed = true;
      if (mm.i_signed) { mm.status = 'active'; mm.activated_at = new Date().toISOString(); }
      this.save();
    }, 1500);
    return { ok: true, marriage_id: m.id };
  }
  async sign(id: string): Promise<Result> {
    const m = this.d.marriages.find((x) => x.id === id);
    if (!m) return { ok: false, message: familyError('GC_NOT_FOUND') };
    if (m.status !== 'proposed') return { ok: false, message: familyError('GC_NOT_OPEN') };
    if (m.i_signed) return { ok: false, message: familyError('GC_ALREADY_SIGNED') };
    m.i_signed = true;
    if (m.partner_signed) { m.status = 'active'; m.activated_at = new Date().toISOString(); }
    this.save();
    return { ok: true, status: m.status };
  }
  async end(id: string, _reason: string): Promise<Result> {
    const m = this.d.marriages.find((x) => x.id === id);
    if (!m) return { ok: false, message: familyError('GC_NOT_FOUND') };
    if (m.status !== 'active') return { ok: false, message: familyError('GC_NOT_OPEN') };
    m.status = 'ended';
    this.save();
    return { ok: true };
  }
  async childbirth(marriageId: string, name: string): Promise<Result> {
    const m = this.d.marriages.find((x) => x.id === marriageId);
    if (!m) return { ok: false, message: familyError('GC_NOT_FOUND') };
    if (m.status !== 'active') return { ok: false, message: familyError('GC_NOT_MARRIED') };
    if (this.ageNow() < 18 || this.ageNow() > 50) return { ok: false, message: familyError('GC_NOT_ELIGIBLE_AGE') };
    const n = name.trim().slice(0, 24);
    if (!n) return { ok: false, message: familyError('GC_INVALID_NAME') };
    const today = new Date().toISOString().slice(0, 10);
    if (this.d.lastBirthDay === today) return { ok: false, message: familyError('GC_ALREADY_BORN_TODAY') };
    const child: LocalChild = {
      id: uuid(), name: n, bornAt: new Date().toISOString(),
      mother: this.store.state.name, father: m.partner,
    };
    this.d.children.push(child);
    this.d.lastBirthDay = today;
    this.save();
    return { ok: true, child_id: child.id, name: n };
  }
  async birthRegistry(day?: string): Promise<BirthRecord[]> {
    const today = day ?? new Date().toISOString().slice(0, 10);
    return this.d.children
      .filter((c) => c.bornAt.slice(0, 10) === today)
      .map((c) => ({ id: c.id, child_id: c.id, name: c.name, born_on: today, mother: c.mother, father: c.father, registered_at: c.bornAt }));
  }
}

export const makeFamily = (store: Store): Family => (cloud.enabled && cloud.signedIn ? new CloudFamily() : new LocalFamily(store));
