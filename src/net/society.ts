/**
 * Civic systems client: education, vehicles, government employment, churches.
 *
 * Online every call is a SECURITY DEFINER database function (see
 * supabase/migrations/*society.sql) and the wallet balance the server returns
 * replaces the local number. Offline practice mode runs the same rules
 * (fees, cooldowns, queue steps, seats) against a save on this device so the
 * city is fully playable without an account — nothing offline is "fake",
 * it is simply local.
 */
import type { Store } from '../game/state';
import { cloud, errorText } from './supabase';

export interface Result { ok: boolean; error?: string; message?: string; replay?: boolean; retry_in?: number; balance?: number }

export interface CourseView { id: string; title: string; fee: number; classes_required: number; pass_mark: number; certificate_title: string; description: string; class_cooldown_s: number; status: 'enrolled' | 'passed' | null; classes_attended: number; attempts: number; next_class_in: number }
export interface CertificateView { id: string; course_id: string; title: string; grade: string; score: number; serial: string; issued_at: string }
export interface EducationView { courses: CourseView[]; certificates: CertificateView[] }
export interface ClassResult extends Result { classes_attended?: number; classes_required?: number; ready?: boolean }
export interface ExamResult extends Result { passed?: boolean; score?: number; pass_mark?: number; certificate?: CertificateView }

export interface VehicleModel { id: string; name: string; kind: 'car' | 'keke' | 'bus'; price: number; colors: string[]; top_speed: number; stock: number; requires_licence: boolean; description: string }
export interface VehicleView { id: string; model_id: string; name: string; kind: 'car' | 'keke' | 'bus'; color: string; plate: string; condition: number; x: number; z: number; yaw: number; area: string; top_speed: number; owner_id: string; owner_name?: string; mine: boolean; keys: string[] }
export interface BuyVehicleResult extends Result { vehicle?: VehicleView }

export interface GovPosition { id: string; dept: string; title: string; grade: number; salary_per_shift: number; required_course: string | null; required_title: string | null; has_certificate: boolean; slots: number; filled: number; queue: number; description: string }
export interface GovStep { step: number; name: string; actor: string; description: string }
export interface GovApplication { id: string; position_id: string; title: string; step: number; status: 'in_progress' | 'rejected' | 'withdrawn' | 'hired' | 'declined'; queue_no: number | null; queue_ahead: number; wait_s: number; interview_attempts: number; interview_score: number | null; reason: string | null; history: { step: number; at: string; note: string }[]; submitted_at: string }
export interface GovEmployment { position_id: string; title: string; dept: string; employee_no: string; salary_per_shift: number; shifts_worked: number; last_shift_at: string | null; next_shift_in: number; hired_at: string }
export interface GovStatus { positions: GovPosition[]; steps: GovStep[]; application: GovApplication | null; employment: GovEmployment | null; payroll_balance: number; config: Record<string, number> }
export interface InterviewQuestion { id: number; question: string; options: string[] }
export interface InterviewResult extends Result { passed?: boolean; score?: number; rejected?: boolean; step?: number }
export interface ShiftResult extends Result { paid?: number; shift?: number }

export interface ChurchService { id: number; title: string; description: string; duration_min: number; live: boolean; starts_in_s: number; ends_in_s: number; attending: number; my_seat: number | null }
export interface ChurchInfo {
  id: string; slug: string; name: string; description: string; seats: number; occupied: number; available: number; pastor: string; pastor_is_me: boolean;
  members: number; attending_now: number; balance: number; my_role: 'member' | 'staff' | 'pastor' | null; services: ChurchService[];
  recent_offerings: { amount: number; at: string; from: string }[]; expenses: { amount: number; reason: string; at: string }[];
  salary: { amount: number; approved_at: string | null; last_paid_at: string | null; pastor_id: string } | null;
  other_churches: { slug: string; name: string; pastor: string; members: number }[];
}
export interface AttendResult extends Result { seat_no?: number; ends_in_s?: number; seats_left?: number; starts_in_s?: number }

export const HOSPITAL_SERVICES = [
  { id: 'svc-checkup', name: 'Check-up (free)', price: 0, icon: '🩺' },
  { id: 'svc-treatment', name: 'Doctor consultation & treatment', price: 2500, icon: '💊' },
  { id: 'med-paracetamol', name: 'Paracetamol (pack)', price: 800, icon: '💊' },
  { id: 'med-vitamin-c', name: 'Vitamin C & multivitamin', price: 1200, icon: '🍊' },
  { id: 'food-moimoi', name: 'Canteen moi-moi & pap', price: 450, icon: '🍮' },
] as const;

export interface Society {
  readonly online: boolean;
  education(): Promise<EducationView>;
  enroll(course: string): Promise<Result>;
  attendClass(course: string): Promise<ClassResult>;
  takeExam(course: string): Promise<ExamResult>;
  /** Cached: does the player hold a (non-revoked) certificate for the course? */
  hasCertificate(course: string): boolean;
  vehicleModels(): Promise<VehicleModel[]>;
  myVehicles(): Promise<VehicleView[]>;
  /** Every citizen's parked vehicle (for the streets). */
  parkedVehicles(): Promise<VehicleView[]>;
  buyVehicle(model: string, color: string, x: number, z: number, yaw: number): Promise<BuyVehicleResult>;
  /** Free starter car (test drive). Idempotent: one per citizen. */
  grantStarterVehicle(x: number, z: number, yaw: number): Promise<BuyVehicleResult>;
  parkVehicle(id: string, x: number, z: number, yaw: number, area: string): Promise<void>;
  shareVehicle(id: string, username: string, grant: boolean): Promise<Result>;
  govStatus(): Promise<GovStatus>;
  govApply(position: string): Promise<Result & { course?: string }>;
  govWithdraw(): Promise<Result>;
  govInterviewQuestions(): Promise<Result & { questions?: InterviewQuestion[] }>;
  govAttendInterview(answers: Record<string, number>): Promise<InterviewResult>;
  govAcceptOffer(accept: boolean): Promise<Result & { employee_no?: string }>;
  govWorkShift(): Promise<ShiftResult>;
  govResign(): Promise<Result>;
  churchInfo(slug: string): Promise<ChurchInfo>;
  churchJoin(slug: string): Promise<Result>;
  churchLeave(slug: string): Promise<Result>;
  churchAttend(serviceId: number): Promise<AttendResult>;
  churchOffer(slug: string, amount: number): Promise<Result>;
  churchRegister(name: string, description: string): Promise<Result & { slug?: string; fee?: number }>;
  churchPay(slug: string, toUsername: string, amount: number, reason: string): Promise<Result>;
  churchSalary(slug: string, action: 'propose' | 'approve' | 'claim', amount?: number): Promise<Result & { status?: string }>;
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));

export const SOCIETY_ERRORS: Record<string, string> = {
  GC_UNKNOWN_COURSE: 'That course is not offered.', GC_NOT_ENROLLED: 'Enrol at the reception desk first.', GC_ALREADY_CERTIFIED: 'You already hold this certificate.',
  GC_CLASSES_INCOMPLETE: 'Attend all required classes before the exam.', GC_READY_FOR_EXAM: 'You have done enough classes — take the exam.',
  GC_LICENCE_REQUIRED: 'Odogwu Motors needs to see a GistCity driver\'s licence (Unity College, 3,000 G).', GC_OUT_OF_STOCK: 'Sold out — check back later.',
  GC_NOT_AUTHORISED: 'You are not authorised to do that.', GC_NOT_OWNER: 'Only the owner can do that.', GC_UNKNOWN_USER: 'No citizen with that username.', GC_SELF: 'That is you.',
  GC_CERTIFICATE_REQUIRED: 'This position requires a certificate you do not hold yet.', GC_ALREADY_EMPLOYED: 'You already hold a government post.', GC_APPLICATION_OPEN: 'You already have an application in progress.',
  GC_NO_INTERVIEW: 'No interview is scheduled for you right now.', GC_NO_OFFER: 'There is no offer waiting for you.', GC_NOT_EMPLOYED: 'You are not a government employee.', GC_PAYROLL_EMPTY: 'The payroll account cannot cover this shift. Try later.',
  GC_NO_APPLICATION: 'You have no open application.', GC_UNKNOWN_CHURCH: 'Unknown church.', GC_SERVICE_NOT_LIVE: 'That service is not on right now.', GC_NO_SEATS: 'The hall is full for this service.',
  GC_PASTOR_CANNOT_LEAVE: 'A pastor cannot leave their own church.', GC_ALREADY_PASTOR: 'You already lead a church.', GC_NAME_TAKEN: 'A church with that name already exists.', GC_INVALID_NAME: 'Choose a longer name.',
  GC_REASON_REQUIRED: 'Give a reason for the expense.', GC_NO_PROPOSAL: 'No salary proposal yet.', GC_NOT_APPROVED: 'The salary agreement has not been approved by a member.', GC_CHURCH_FUNDS_LOW: 'The church account cannot cover that.',
  GC_COOLDOWN: 'Not yet — wait a little.', GC_INSUFFICIENT_FUNDS: 'Not enough G in your wallet.', GC_INVALID_AMOUNT: 'Enter an amount above 0.',
};
export const societyError = (code?: string) => (code && SOCIETY_ERRORS[code]) || errorText(code);
const fail = (code: string, extra: Record<string, unknown> = {}): any => ({ ok: false, error: code, message: societyError(code), ...extra });
const withMsg = <T extends Result>(r: T): T => { if (!r.ok && r.error && !r.message) r.message = societyError(r.error); return r; };

/* ------------------------------------------------------------------ cloud */

export class CloudSociety implements Society {
  readonly online = true;
  private certs = new Set<string>();
  constructor(private store: Store, certificates: string[] = []) { for (const c of certificates) this.certs.add(c); }
  private settle<T extends Result>(r: T): T {
    if (typeof r.balance === 'number') this.store.update((s) => { s.cash = r.balance!; });
    return withMsg(r);
  }
  private async call<T extends Result>(fn: string, args: Record<string, unknown>): Promise<T> {
    try { return this.settle(await cloud.rpc<T>(fn, args)); }
    catch (e: any) { const m = String(e?.message ?? ''); const code = (m.match(/GC_[A-Z_]+/) || [m.includes('Failed to fetch') ? 'network' : m])[0]; return fail(code) as T; }
  }
  async education() { const v = await cloud.rpc<EducationView>('my_education', {}); this.certs = new Set(v.certificates.map((c) => c.course_id)); return v; }
  enroll(course: string) { return this.call<Result>('school_enroll', { p_course: course, p_key: uuid() }); }
  attendClass(course: string) { return this.call<ClassResult>('school_attend_class', { p_course: course }); }
  async takeExam(course: string) { const r = await this.call<ExamResult>('school_take_exam', { p_course: course, p_key: uuid() }); if (r.passed) this.certs.add(course); return r; }
  hasCertificate(course: string) { return this.certs.has(course); }
  async vehicleModels() { const { data } = await cloud.client!.from('vehicle_models').select('*').order('sort'); return (data ?? []) as VehicleModel[]; }
  vehicles = () => cloud.rpc<VehicleView[]>('my_vehicles', {});
  myVehicles() { return this.vehicles(); }
  async parkedVehicles() { const { data } = await cloud.client!.from('vehicles_public').select('*').limit(300); return ((data ?? []) as any[]).map((v) => ({ ...v, name: v.model_id, kind: v.model_id.startsWith('keke') ? 'keke' : v.model_id.startsWith('danfo') ? 'bus' : 'car', condition: 100, top_speed: 12, mine: v.owner_id === cloud.user?.id, keys: [] })) as VehicleView[]; }
  buyVehicle(model: string, color: string, x: number, z: number, yaw: number) { return this.call<BuyVehicleResult>('buy_vehicle', { p_model: model, p_color: color, p_x: x, p_z: z, p_yaw: yaw, p_key: uuid() }); }
  async parkVehicle(id: string, x: number, z: number, yaw: number, area: string) { try { await cloud.rpc('park_vehicle', { p_vehicle: id, p_x: x, p_z: z, p_yaw: yaw, p_area: area }); } catch { /* best effort */ } }
  async grantStarterVehicle(_x: number, _z: number, _yaw: number): Promise<BuyVehicleResult> {
    // Server-side gifting needs an RPC (docs/AUDIT.md §11). Practice mode gets the free car.
    return { ok: false, error: 'GC_PRACTICE_ONLY', message: 'The starter car is handed over in practice mode for now.' };
  }
  shareVehicle(id: string, username: string, grant: boolean) { return this.call<Result>('vehicle_share', { p_vehicle: id, p_username: username, p_grant: grant }); }
  govStatus() { return cloud.rpc<GovStatus>('gov_my_status', {}); }
  govApply(position: string) { return this.call<Result & { course?: string }>('gov_apply', { p_position: position }); }
  govWithdraw() { return this.call<Result>('gov_withdraw', {}); }
  govInterviewQuestions() { return this.call<Result & { questions?: InterviewQuestion[] }>('gov_interview_questions', {}); }
  govAttendInterview(answers: Record<string, number>) { return this.call<InterviewResult>('gov_attend_interview', { p_answers: answers }); }
  govAcceptOffer(accept: boolean) { return this.call<Result & { employee_no?: string }>('gov_accept_offer', { p_accept: accept }); }
  govWorkShift() { return this.call<ShiftResult>('gov_work_shift', { p_key: uuid() }); }
  govResign() { return this.call<Result>('gov_resign', {}); }
  churchInfo(slug: string) { return cloud.rpc<ChurchInfo>('church_info', { p_slug: slug }); }
  churchJoin(slug: string) { return this.call<Result>('church_join', { p_slug: slug }); }
  churchLeave(slug: string) { return this.call<Result>('church_leave', { p_slug: slug }); }
  churchAttend(serviceId: number) { return this.call<AttendResult>('church_attend', { p_service: serviceId }); }
  churchOffer(slug: string, amount: number) { return this.call<Result>('church_offer', { p_slug: slug, p_amount: Math.floor(amount), p_key: uuid() }); }
  churchRegister(name: string, description: string) { return this.call<Result & { slug?: string; fee?: number }>('church_register', { p_name: name, p_description: description, p_key: uuid() }); }
  churchPay(slug: string, toUsername: string, amount: number, reason: string) { return this.call<Result>('church_pay', { p_slug: slug, p_to_username: toUsername, p_amount: Math.floor(amount), p_reason: reason, p_key: uuid() }); }
  churchSalary(slug: string, action: 'propose' | 'approve' | 'claim', amount?: number) { return this.call<Result & { status?: string }>('church_salary', { p_slug: slug, p_action: action, p_amount: amount ?? null, p_key: action === 'claim' ? uuid() : null }); }
}

/* ------------------------------------------------------------------ local */

/** Static copies of the server seed data (display + practice rules). The database is authoritative online. */
export const COURSES: Omit<CourseView, 'status' | 'classes_attended' | 'attempts' | 'next_class_in'>[] = [
  { id: 'drivers-licence', title: 'Driving School & Licence Test', fee: 3000, classes_required: 2, pass_mark: 60, class_cooldown_s: 20, certificate_title: "GistCity Driver's Licence", description: 'Road signs, parking and the highway code. Odogwu Motors will not sell a vehicle to anyone without this licence.' },
  { id: 'computer-studies', title: 'Basic Computer Studies', fee: 5000, classes_required: 3, pass_mark: 60, class_cooldown_s: 25, certificate_title: 'Certificate in Computer Studies', description: 'Typing, spreadsheets and e-mail. Opens IT support positions in government.' },
  { id: 'public-admin', title: 'Diploma in Public Administration', fee: 12000, classes_required: 4, pass_mark: 60, class_cooldown_s: 30, certificate_title: 'Diploma in Public Administration', description: 'How the Secretariat works. Required for registry and revenue positions.' },
  { id: 'nursing-assistant', title: 'Nursing Assistant Course', fee: 15000, classes_required: 4, pass_mark: 65, class_cooldown_s: 30, certificate_title: 'Nursing Assistant Certificate', description: 'First aid, patient care and hygiene. Required for community health positions.' },
  { id: 'business-basics', title: 'Small Business Management', fee: 8000, classes_required: 3, pass_mark: 60, class_cooldown_s: 25, certificate_title: 'Certificate in Business Management', description: 'Book-keeping, pricing and staff. Will be required to register a business.' },
];
export const VEHICLE_MODELS: VehicleModel[] = [
  { id: 'keke-napep', name: 'Keke NAPEP', kind: 'keke', price: 45000, colors: ['#f1c40f', '#2ecc71', '#2e86de'], top_speed: 9, stock: 60, requires_licence: true, description: "Three wheels, zero stress. The city hustler's first ride." },
  { id: 'toks-corolla', name: 'Toks Corolla 2012', kind: 'car', price: 180000, colors: ['#bdc3c7', '#2c3e50', '#c0392b', '#ecf0f1'], top_speed: 14, stock: 40, requires_licence: true, description: 'Clean tokunbo. Reliable, and the AC works.' },
  { id: 'venza-x', name: 'Venza X crossover', kind: 'car', price: 420000, colors: ['#1a1a1a', '#7f8c8d', '#8e44ad', '#e67e22'], top_speed: 16, stock: 25, requires_licence: true, description: 'The soft-life crossover.' },
  { id: 'odogwu-g630', name: 'Odogwu G-630', kind: 'car', price: 1500000, colors: ['#0b0e0c', '#ecf0f1', '#a5ff38'], top_speed: 19, stock: 6, requires_licence: true, description: 'Statement car. Everybody will know you have arrived.' },
  { id: 'danfo-14', name: 'Danfo 14-seater', kind: 'bus', price: 260000, colors: ['#f1c40f'], top_speed: 12, stock: 12, requires_licence: true, description: 'The yellow bus. Commercial routes coming soon.' },
];
export const GOV_POSITIONS: Omit<GovPosition, 'has_certificate' | 'filled' | 'queue'>[] = [
  { id: 'road-marshal', dept: 'Ministry of Works & Roads', title: 'Road Safety Marshal', grade: 3, salary_per_shift: 15000, required_course: 'drivers-licence', required_title: "GistCity Driver's Licence", slots: 25, description: 'Keep the roundabout moving. Shifts at the Secretariat traffic desk.' },
  { id: 'registry-clerk', dept: 'Civil Registry', title: 'Registry Clerk', grade: 4, salary_per_shift: 18000, required_course: 'public-admin', required_title: 'Diploma in Public Administration', slots: 20, description: 'File citizen records and issue certificates.' },
  { id: 'it-support', dept: 'Ministry of Works & Roads', title: 'IT Support Officer', grade: 6, salary_per_shift: 26000, required_course: 'computer-studies', required_title: 'Certificate in Computer Studies', slots: 12, description: 'Keep the Secretariat computers running.' },
  { id: 'health-assistant', dept: 'Ministry of Health', title: 'Community Health Assistant', grade: 6, salary_per_shift: 28000, required_course: 'nursing-assistant', required_title: 'Nursing Assistant Certificate', slots: 12, description: 'Public health outreach from the Secretariat.' },
  { id: 'revenue-officer', dept: 'Internal Revenue Service', title: 'Revenue Officer', grade: 7, salary_per_shift: 30000, required_course: 'public-admin', required_title: 'Diploma in Public Administration', slots: 8, description: 'Assess and collect city revenue.' },
];
export const GOV_STEPS: GovStep[] = [
  { step: 1, name: 'Application submitted', actor: 'applicant', description: 'Your application is in the system.' },
  { step: 2, name: 'Documents verified', actor: 'office', description: 'The Registry checks your certificate against the school records.' },
  { step: 3, name: 'Eligibility confirmed', actor: 'office', description: 'Account in good standing, no other government post.' },
  { step: 4, name: 'Queued', actor: 'office', description: 'You are in the queue for this position (first come, first served).' },
  { step: 5, name: 'Shortlisted', actor: 'office', description: 'A slot is available and you reached the front of the queue.' },
  { step: 6, name: 'Interview scheduled', actor: 'office', description: 'Come to the Secretariat employment desk for your interview.' },
  { step: 7, name: 'Interview completed', actor: 'applicant', description: 'Three questions at the employment desk.' },
  { step: 8, name: 'Offer issued', actor: 'office', description: 'Congratulations: a formal offer is waiting for you.' },
  { step: 9, name: 'Offer accepted', actor: 'applicant', description: 'Accept the offer at the employment desk.' },
  { step: 10, name: 'Onboarded', actor: 'office', description: 'Employee number issued. Report for shifts to earn your salary.' },
];
const INTERVIEW: (InterviewQuestion & { answer: number })[] = [
  { id: 1, question: 'A citizen at your desk is angry about a long queue. What do you do?', options: ['Shout back so they respect the office', 'Listen, explain the process and give them a queue number', 'Ignore them until they leave'], answer: 1 },
  { id: 2, question: 'What is the official currency of GistCity?', options: ['Naira', 'G', 'Cowries'], answer: 1 },
  { id: 3, question: 'Where does a government salary come from?', options: ['The Government Payroll account', 'The Treasury prints new money every day', "Your supervisor's personal wallet"], answer: 0 },
  { id: 4, question: 'A friend asks you to approve their application out of turn. You…', options: ['Approve it — friends first', 'Explain that applications are processed in queue order', 'Ask for a small gift first'], answer: 1 },
  { id: 5, question: 'Which document proves a citizen completed a Unity College course?', options: ['A screenshot of the classroom', 'A certificate serial that the Registry can verify', 'A letter from a friend'], answer: 1 },
  { id: 6, question: 'Office hours are over and a form is half-filled. You…', options: ['Save it and continue in the next shift', 'Throw it away', 'Sign it unread to finish quickly'], answer: 0 },
];
const STEP_INTERVAL_S = 20, SHIFT_COOLDOWN_S = 120, CHURCH_FEE = 50000;
const SERVICES = [
  { id: 1, title: 'Hourly Prayer Service', every: 60, offset: 0, duration: 15, description: 'Fifteen minutes of prayer and a short word, every hour on the hour.' },
  { id: 2, title: 'Evening Service', every: 1440, offset: 17 * 60, duration: 45, description: 'Daily at 17:00 UTC (18:00 Lagos): worship, sermon and offering.' },
  { id: 3, title: 'Sunday Celebration', every: 10080, offset: 3 * 1440 + 8 * 60, duration: 90, description: 'Sundays 08:00 UTC (09:00 Lagos): the big service. Dress well.' },
];
export function serviceState(every: number, offset: number, duration: number, nowMs = Date.now()) {
  const m = nowMs / 60000, rel = m - offset, occ = Math.floor(rel / every), pos = rel - occ * every, live = pos < duration;
  return { live, occurrence: occ, starts_in_s: live ? 0 : Math.ceil((every - pos) * 60), ends_in_s: live ? Math.ceil((duration - pos) * 60) : 0 };
}

interface LocalData {
  enrollments: Record<string, { classes_attended: number; status: 'enrolled' | 'passed'; attempts: number; last_class_at: number }>;
  certificates: CertificateView[];
  vehicles: VehicleView[];
  stock: Record<string, number>;
  application: GovApplication | null;
  employment: GovEmployment | null;
  churches: { slug: string; name: string; description: string; pastor: string; mine: boolean; balance: number; members: number; seats: number; services: typeof SERVICES; expenses: { amount: number; reason: string; at: string }[]; offerings: { amount: number; at: string; from: string }[]; salary: { amount: number; approved_at: string | null; last_paid_at: string | null; pastor_id: string } | null }[];
  membership: { slug: string; role: 'member' | 'pastor' } | null;
  attendance: Record<string, number>;   // `${slug}:${serviceId}:${occurrence}` → seat
}
const LKEY = 'gist_society_v1';
const blankLocal = (): LocalData => ({
  enrollments: {}, certificates: [], vehicles: [], stock: {}, application: null, employment: null,
  churches: [{ slug: 'grace-chapel', name: 'Grace Chapel GistCity', description: 'A home for every GistCitizen. Hourly prayer services, Sunday celebration and a community kitchen fund.', pastor: 'Pastor Emmanuel Okafor', mine: false, balance: 0, members: 23, seats: 48, services: SERVICES, expenses: [], offerings: [], salary: null }],
  membership: null, attendance: {},
});

export class LocalSociety implements Society {
  readonly online = false;
  private d: LocalData;
  constructor(private store: Store) {
    let d: LocalData | null = null;
    try { const raw = localStorage.getItem(LKEY); if (raw) d = { ...blankLocal(), ...JSON.parse(raw) }; } catch { /* fresh */ }
    this.d = d ?? blankLocal();
  }
  private save() { try { localStorage.setItem(LKEY, JSON.stringify(this.d)); } catch { /* ignore */ } }
  private pay(amount: number): boolean { if (this.store.state.cash < amount) return false; this.store.update((s) => { s.cash -= amount; }); return true; }
  private earn(amount: number) { this.store.update((s) => { s.cash += amount; }); }
  private get me() { return this.store.state.name; }

  async education(): Promise<EducationView> {
    const now = Date.now();
    return {
      courses: COURSES.map((c) => { const e = this.d.enrollments[c.id]; return { ...c, status: e?.status ?? null, classes_attended: e?.classes_attended ?? 0, attempts: e?.attempts ?? 0, next_class_in: e ? Math.max(0, Math.ceil((e.last_class_at + c.class_cooldown_s * 1000 - now) / 1000)) : 0 }; }),
      certificates: [...this.d.certificates].reverse(),
    };
  }
  async enroll(course: string): Promise<Result> {
    const c = COURSES.find((x) => x.id === course); if (!c) return fail('GC_UNKNOWN_COURSE');
    const e = this.d.enrollments[course];
    if (e?.status === 'passed') return fail('GC_ALREADY_CERTIFIED');
    if (e) return { ok: true, replay: true };
    if (!this.pay(c.fee)) return fail('GC_INSUFFICIENT_FUNDS');
    this.d.enrollments[course] = { classes_attended: 0, status: 'enrolled', attempts: 0, last_class_at: 0 }; this.save();
    return { ok: true };
  }
  async attendClass(course: string): Promise<ClassResult> {
    const c = COURSES.find((x) => x.id === course); const e = this.d.enrollments[course];
    if (!c) return fail('GC_UNKNOWN_COURSE'); if (!e) return fail('GC_NOT_ENROLLED'); if (e.status === 'passed') return fail('GC_ALREADY_CERTIFIED');
    const wait = Math.ceil((e.last_class_at + c.class_cooldown_s * 1000 - Date.now()) / 1000);
    if (wait > 0) return fail('GC_COOLDOWN', { retry_in: wait, classes_attended: e.classes_attended, classes_required: c.classes_required });
    if (e.classes_attended >= c.classes_required + 2) return fail('GC_READY_FOR_EXAM', { classes_attended: e.classes_attended, classes_required: c.classes_required });
    e.classes_attended++; e.last_class_at = Date.now(); this.save();
    return { ok: true, classes_attended: e.classes_attended, classes_required: c.classes_required, ready: e.classes_attended >= c.classes_required };
  }
  async takeExam(course: string): Promise<ExamResult> {
    const c = COURSES.find((x) => x.id === course); const e = this.d.enrollments[course];
    if (!c) return fail('GC_UNKNOWN_COURSE'); if (!e) return fail('GC_NOT_ENROLLED'); if (e.status === 'passed') return fail('GC_ALREADY_CERTIFIED');
    if (e.classes_attended < c.classes_required) return fail('GC_CLASSES_INCOMPLETE', { classes_attended: e.classes_attended, classes_required: c.classes_required });
    const score = Math.min(100, 50 + Math.floor(Math.random() * 41) + 10 * Math.min(2, e.classes_attended - c.classes_required));
    e.attempts++;
    if (score >= c.pass_mark) {
      e.status = 'passed';
      const cert: CertificateView = { id: uuid(), course_id: c.id, title: c.certificate_title, grade: score >= 85 ? 'A' : score >= 75 ? 'B' : 'C', score, serial: 'GC-' + Math.random().toString(16).slice(2, 12).toUpperCase(), issued_at: new Date().toISOString() };
      this.d.certificates.push(cert); this.save();
      return { ok: true, passed: true, score, certificate: cert };
    }
    e.classes_attended = Math.max(0, c.classes_required - 1); this.save();
    return { ok: true, passed: false, score, pass_mark: c.pass_mark };
  }
  hasCertificate(course: string) { return this.d.certificates.some((c) => c.course_id === course); }

  async vehicleModels() { return VEHICLE_MODELS.map((m) => ({ ...m, stock: m.stock - (this.d.stock[m.id] ?? 0) })); }
  async myVehicles() { return this.d.vehicles; }
  async parkedVehicles() { return []; }
  async buyVehicle(model: string, color: string, x: number, z: number, yaw: number): Promise<BuyVehicleResult> {
    const m = VEHICLE_MODELS.find((v) => v.id === model); if (!m) return fail('GC_UNKNOWN_VEHICLE');
    if (m.requires_licence && !this.hasCertificate('drivers-licence')) return fail('GC_LICENCE_REQUIRED');
    if (m.stock - (this.d.stock[m.id] ?? 0) <= 0) return fail('GC_OUT_OF_STOCK');
    if (!this.pay(m.price)) return fail('GC_INSUFFICIENT_FUNDS');
    this.d.stock[m.id] = (this.d.stock[m.id] ?? 0) + 1;
    const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
    const v: VehicleView = { id: uuid(), model_id: m.id, name: m.name, kind: m.kind, color: m.colors.includes(color) ? color : m.colors[0], plate: `GC-${L[Math.floor(Math.random() * L.length)]}${L[Math.floor(Math.random() * L.length)]}${L[Math.floor(Math.random() * L.length)]}-${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`, condition: 100, x, z, yaw, area: 'city', top_speed: m.top_speed, owner_id: 'local', mine: true, keys: [] };
    this.d.vehicles.push(v); this.save();
    return { ok: true, vehicle: v };
  }
  async grantStarterVehicle(x: number, z: number, yaw: number): Promise<BuyVehicleResult> {
    const own = this.d.vehicles[0];
    if (own) return { ok: true, vehicle: own };
    const m = VEHICLE_MODELS.find((v) => v.id === 'toks-corolla') ?? VEHICLE_MODELS[0]!;
    const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
    const v: VehicleView = { id: uuid(), model_id: m.id, name: m.name, kind: m.kind, color: m.colors[0] ?? '#fff', plate: `GC-${L[Math.floor(Math.random() * L.length)]}${L[Math.floor(Math.random() * L.length)]}${L[Math.floor(Math.random() * L.length)]}-007`, condition: 100, x, z, yaw, area: 'city', top_speed: m.top_speed, owner_id: 'local', mine: true, keys: [] };
    this.d.vehicles.push(v); this.save();
    return { ok: true, vehicle: v };
  }
  async parkVehicle(id: string, x: number, z: number, yaw: number, area: string) { const v = this.d.vehicles.find((q) => q.id === id); if (v) { v.x = x; v.z = z; v.yaw = yaw; v.area = area; this.save(); } }
  async shareVehicle(): Promise<Result> { return { ok: false, error: 'offline', message: 'Sharing keys needs an online account.' }; }

  private govProcess() {
    const a = this.d.application; if (!a || a.status !== 'in_progress') return;
    const now = Date.now();
    const advance = (step: number, note: string) => { a.step = step; a.history.push({ step, at: new Date().toISOString(), note }); a.wait_s = STEP_INTERVAL_S; (a as any)._next = now + STEP_INTERVAL_S * 1000; };
    let guard = 0;
    while (guard++ < 10 && a.status === 'in_progress' && a.step <= 5 && ((a as any)._next ?? 0) <= now) {
      const p = GOV_POSITIONS.find((x) => x.id === a.position_id)!;
      if (a.step === 1) { if (!p.required_course || this.hasCertificate(p.required_course)) advance(2, 'Certificate verified against Unity College records'); else { a.status = 'rejected'; a.reason = 'Required certificate not found'; } }
      else if (a.step === 2) { if (this.d.employment) { a.status = 'rejected'; a.reason = 'Applicant already holds a government post'; } else advance(3, 'Eligibility confirmed'); }
      else if (a.step === 3) { a.queue_no = Math.floor(1000 + Math.random() * 9000); advance(4, 'Queue number ' + a.queue_no); }
      else if (a.step === 4) { a.queue_ahead = 0; advance(5, 'Shortlisted: slot available'); }
      else if (a.step === 5) advance(6, 'Interview scheduled at the employment desk');
    }
    a.wait_s = Math.max(0, Math.ceil((((a as any)._next ?? 0) - now) / 1000));
    this.save();
  }
  async govStatus(): Promise<GovStatus> {
    this.govProcess();
    const e = this.d.employment;
    if (e) e.next_shift_in = e.last_shift_at ? Math.max(0, Math.ceil((new Date(e.last_shift_at).getTime() + SHIFT_COOLDOWN_S * 1000 - Date.now()) / 1000)) : 0;
    return {
      positions: GOV_POSITIONS.map((p) => ({ ...p, has_certificate: !p.required_course || this.hasCertificate(p.required_course), filled: p.id === e?.position_id ? 1 : 0, queue: this.d.application?.position_id === p.id && this.d.application.status === 'in_progress' ? 1 : 0 })),
      steps: GOV_STEPS, application: this.d.application, employment: e, payroll_balance: 500000000000, config: { step_interval_s: STEP_INTERVAL_S, shift_cooldown_s: SHIFT_COOLDOWN_S },
    };
  }
  async govApply(position: string): Promise<Result & { course?: string }> {
    const p = GOV_POSITIONS.find((x) => x.id === position); if (!p) return fail('GC_UNKNOWN_POSITION');
    if (this.d.employment) return fail('GC_ALREADY_EMPLOYED');
    if (this.d.application?.status === 'in_progress') return fail('GC_APPLICATION_OPEN');
    if (p.required_course && !this.hasCertificate(p.required_course)) return fail('GC_CERTIFICATE_REQUIRED', { course: p.required_course });
    this.d.application = { id: uuid(), position_id: p.id, title: p.title, step: 1, status: 'in_progress', queue_no: null, queue_ahead: 0, wait_s: 0, interview_attempts: 0, interview_score: null, reason: null, history: [{ step: 1, at: new Date().toISOString(), note: 'Submitted at the employment desk' }], submitted_at: new Date().toISOString() };
    this.govProcess();
    return { ok: true };
  }
  async govWithdraw(): Promise<Result> { const a = this.d.application; if (!a || a.status !== 'in_progress') return fail('GC_NO_APPLICATION'); a.status = 'withdrawn'; this.save(); return { ok: true }; }
  async govInterviewQuestions() {
    this.govProcess(); const a = this.d.application;
    if (!a || a.status !== 'in_progress' || a.step !== 6) return fail('GC_NO_INTERVIEW');
    const qs = [...INTERVIEW].sort(() => Math.random() - 0.5).slice(0, 3).map(({ answer: _a, ...q }) => q);
    return { ok: true, questions: qs };
  }
  async govAttendInterview(answers: Record<string, number>): Promise<InterviewResult> {
    this.govProcess(); const a = this.d.application;
    if (!a || a.status !== 'in_progress' || a.step !== 6) return fail('GC_NO_INTERVIEW');
    let score = 0, n = 0;
    for (const [id, choice] of Object.entries(answers)) { const q = INTERVIEW.find((x) => x.id === Number(id)); if (q && n < 3) { n++; if (q.answer === choice) score++; } }
    a.interview_attempts++; a.interview_score = score;
    if (score >= 2) { a.step = 8; a.history.push({ step: 7, at: new Date().toISOString(), note: `Interview passed (${score}/3)` }, { step: 8, at: new Date().toISOString(), note: 'Offer issued' }); this.save(); return { ok: true, passed: true, score, step: 8 }; }
    if (a.interview_attempts >= 3) { a.status = 'rejected'; a.reason = 'Interview not passed after 3 attempts'; this.save(); return { ok: true, passed: false, score, rejected: true }; }
    a.step = 4; (a as any)._next = Date.now() + STEP_INTERVAL_S * 1000; a.history.push({ step: 4, at: new Date().toISOString(), note: `Interview not passed (${score}/3) — re-queued` }); this.save();
    return { ok: true, passed: false, score, step: 4 };
  }
  async govAcceptOffer(accept: boolean) {
    const a = this.d.application; if (!a || a.status !== 'in_progress' || a.step !== 8) return fail('GC_NO_OFFER');
    if (!accept) { a.status = 'declined'; this.save(); return { ok: true }; }
    const p = GOV_POSITIONS.find((x) => x.id === a.position_id)!;
    const no = 'GOV-' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    a.step = 10; a.status = 'hired'; a.history.push({ step: 9, at: new Date().toISOString(), note: 'Offer accepted' }, { step: 10, at: new Date().toISOString(), note: 'Onboarded as ' + no });
    this.d.employment = { position_id: p.id, title: p.title, dept: p.dept, employee_no: no, salary_per_shift: p.salary_per_shift, shifts_worked: 0, last_shift_at: null, next_shift_in: 0, hired_at: new Date().toISOString() };
    this.save();
    return { ok: true, employee_no: no };
  }
  async govWorkShift(): Promise<ShiftResult> {
    const e = this.d.employment; if (!e) return fail('GC_NOT_EMPLOYED');
    const wait = e.last_shift_at ? Math.ceil((new Date(e.last_shift_at).getTime() + SHIFT_COOLDOWN_S * 1000 - Date.now()) / 1000) : 0;
    if (wait > 0) return fail('GC_COOLDOWN', { retry_in: wait });
    e.shifts_worked++; e.last_shift_at = new Date().toISOString(); this.earn(e.salary_per_shift); this.save();
    return { ok: true, paid: e.salary_per_shift, shift: e.shifts_worked };
  }
  async govResign(): Promise<Result> { if (!this.d.employment) return fail('GC_NOT_EMPLOYED'); this.d.employment = null; this.save(); return { ok: true }; }

  private church(slug: string) { const c = this.d.churches.find((x) => x.slug === slug); if (!c) throw new Error('GC_UNKNOWN_CHURCH'); return c; }
  async churchInfo(slug: string): Promise<ChurchInfo> {
    const c = this.church(slug);
    const services: ChurchService[] = c.services.map((s) => { const st = serviceState(s.every, s.offset, s.duration); const key = `${slug}:${s.id}:${st.occurrence}`; const others = st.live ? 3 + ((st.occurrence + s.id) % 9) : 0; return { id: s.id, title: s.title, description: s.description, duration_min: s.duration, live: st.live, starts_in_s: st.starts_in_s, ends_in_s: st.ends_in_s, attending: others + (this.d.attendance[key] ? 1 : 0), my_seat: this.d.attendance[key] ?? null }; });
    const occupied = services.filter((s) => s.live).reduce((n, s) => n + s.attending, 0);
    return { id: slug, slug, name: c.name, description: c.description, seats: c.seats, occupied, available: c.seats - occupied, pastor: c.pastor, pastor_is_me: c.mine, members: c.members + (this.d.membership?.slug === slug ? 1 : 0), attending_now: occupied, balance: c.balance, my_role: this.d.membership?.slug === slug ? this.d.membership.role : null, services, recent_offerings: [...c.offerings].reverse().slice(0, 8), expenses: [...c.expenses].reverse().slice(0, 8), salary: c.salary, other_churches: this.d.churches.filter((o) => o.slug !== slug).map((o) => ({ slug: o.slug, name: o.name, pastor: o.pastor, members: o.members })) };
  }
  async churchJoin(slug: string): Promise<Result> { this.church(slug); if (this.d.membership?.role === 'pastor') return fail('GC_PASTOR_CANNOT_LEAVE'); this.d.membership = { slug, role: 'member' }; this.save(); return { ok: true }; }
  async churchLeave(slug: string): Promise<Result> { if (this.d.membership?.slug === slug && this.d.membership.role === 'pastor') return fail('GC_PASTOR_CANNOT_LEAVE'); if (this.d.membership?.slug === slug) this.d.membership = null; this.save(); return { ok: true }; }
  async churchAttend(serviceId: number): Promise<AttendResult> {
    for (const c of this.d.churches) {
      const s = c.services.find((x) => x.id === serviceId); if (!s) continue;
      const st = serviceState(s.every, s.offset, s.duration);
      if (!st.live) return fail('GC_SERVICE_NOT_LIVE', { starts_in_s: st.starts_in_s });
      const key = `${c.slug}:${s.id}:${st.occurrence}`;
      if (this.d.attendance[key]) return { ok: true, replay: true, seat_no: this.d.attendance[key] };
      const taken = 3 + ((st.occurrence + s.id) % 9);
      if (taken >= c.seats) return fail('GC_NO_SEATS');
      this.d.attendance[key] = taken + 1; this.save();
      return { ok: true, seat_no: taken + 1, ends_in_s: st.ends_in_s, seats_left: c.seats - taken - 1 };
    }
    return fail('GC_UNKNOWN_SERVICE');
  }
  async churchOffer(slug: string, amount: number): Promise<Result> {
    const c = this.church(slug); amount = Math.floor(amount);
    if (!(amount > 0)) return fail('GC_INVALID_AMOUNT'); if (!this.pay(amount)) return fail('GC_INSUFFICIENT_FUNDS');
    c.balance += amount; c.offerings.push({ amount, at: new Date().toISOString(), from: this.me }); this.save(); return { ok: true };
  }
  async churchRegister(name: string, description: string) {
    if (this.d.churches.some((c) => c.mine)) return fail('GC_ALREADY_PASTOR');
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug.length < 3) return fail('GC_INVALID_NAME'); if (this.d.churches.some((c) => c.slug === slug)) return fail('GC_NAME_TAKEN');
    if (!this.pay(CHURCH_FEE)) return fail('GC_INSUFFICIENT_FUNDS', { fee: CHURCH_FEE });
    this.d.churches.push({ slug, name: name.trim(), description: description.slice(0, 400), pastor: this.me, mine: true, balance: 0, members: 0, seats: 40, services: [{ id: 100 + this.d.churches.length, title: 'Fellowship Service', every: 60, offset: 30, duration: 15, description: 'Every hour at half past, in the Grace Chapel hall.' }], expenses: [], offerings: [], salary: null });
    this.d.membership = { slug, role: 'pastor' }; this.save();
    return { ok: true, slug };
  }
  async churchPay(slug: string, toUsername: string, amount: number, reason: string): Promise<Result> {
    const c = this.church(slug); if (!c.mine) return fail('GC_NOT_AUTHORISED'); if (!reason.trim()) return fail('GC_REASON_REQUIRED');
    amount = Math.floor(amount); if (!(amount > 0)) return fail('GC_INVALID_AMOUNT'); if (c.balance < amount) return fail('GC_INSUFFICIENT_FUNDS');
    c.balance -= amount; c.expenses.push({ amount, reason: `${reason} → @${toUsername}`, at: new Date().toISOString() }); this.save(); return { ok: true };
  }
  async churchSalary(slug: string, action: 'propose' | 'approve' | 'claim', amount?: number) {
    const c = this.church(slug);
    if (action === 'propose') { if (!c.mine) return fail('GC_NOT_AUTHORISED'); if (!(amount && amount > 0)) return fail('GC_INVALID_AMOUNT'); c.salary = { amount, approved_at: null, last_paid_at: null, pastor_id: 'local' }; this.save(); return { ok: true, status: 'proposed' }; }
    if (action === 'approve') return fail('GC_NOT_AUTHORISED', { message: 'A member other than the pastor must approve the salary — needs an online congregation.' });
    if (!c.salary?.approved_at) return fail('GC_NOT_APPROVED');
    return fail('GC_NOT_APPROVED');
  }
}

export function makeSociety(store: Store, certificates: string[] = []): Society {
  return cloud.signedIn ? new CloudSociety(store, certificates) : new LocalSociety(store);
}
