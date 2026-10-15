/**
 * Citizen pages & private messages (DMs).
 *
 * The profile page is public: picture, display name, @username, occupation,
 * bio, follower counts, and a gallery of public photos & short clips — plus
 * follow / message / block / report, and (on your own page) upload & delete.
 *
 * DMs are private conversations with text and permitted photo attachments,
 * unread badges, live replies and blocking that the server enforces.
 */
import type { MediaItem, Message, ProfilePage, ReportReason, Social, Thread } from '../net/social';

export interface SocialHost {
  social: Social;
  myUsername(): string;
  myName(): string;
  openPanel(id: string): void;
  closeAll(): void;
  toast(msg: string, ms?: number): void;
  ask(title: string, hint: string, placeholder: string, numeric?: boolean): Promise<string | null>;
  confirm(title: string): boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class SocialUI {
  private page: ProfilePage | null = null;
  private threads: Thread[] = [];
  private openConv: string | null = null;
  private openThread: Thread | null = null;
  private msgs: Message[] = [];
  private filePhoto: HTMLInputElement | null = null;
  private fileClip: HTMLInputElement | null = null;
  private attach: HTMLInputElement | null = null;
  private pendingAttach: string | null = null;
  /** Panel-renderer hooks (called by the HUD when a panel opens/closes). */
  render(id: string) {
    if (id === 'profile') void this.renderProfile();
    if (id === 'dm') void this.renderDm();
  }
  stopTimers() { /* nothing ticking */ }

  constructor(private host: SocialHost) {}

  /* -------------------------------------------------------- profile page */

  async openProfile(username: string) {
    this.page = null;
    this.host.openPanel('profile');
    $('#profileBody').innerHTML = '<p class="muted">Loading page…</p>';
    try {
      this.page = await this.host.social.profilePage(username);
    } catch (e: any) {
      $('#profileBody').innerHTML = `<p class="muted">${esc(e?.message ?? 'Could not load this page')}</p>`;
      return;
    }
    await this.renderProfile();
  }

  private async renderProfile() {
    const p = this.page;
    const body = $('#profileBody');
    if (!p) return;
    const mine = p.username === this.host.myUsername() || p.id === 'me';
    $('#profileKicker').textContent = mine ? 'YOUR PUBLIC PAGE' : 'CITIZEN';
    $('#profileTitle').textContent = p.display_name;

    body.innerHTML = `
      <div class="profileHead">
        <div class="avatarBig" data-av>${esc(p.display_name.charAt(0).toUpperCase())}</div>
        <div>
          <strong>${esc(p.display_name)}</strong>
          <small>@${esc(p.username)}</small>
          <small>${esc(p.occupation)}</small>
        </div>
      </div>
      <div class="profileStats">
        <span><b>${p.followers}</b> followers</span>
        <span><b>${p.following}</b> following</span>
        <span><b>${p.media.length}</b> posts</span>
      </div>
      <p class="bio">${esc(p.bio) || '<span class="muted">No bio yet.</span>'}</p>
      ${p.follows_me && !mine ? '<p class="muted">This citizen follows you.</p>' : ''}
      <div class="profileActions">
        ${mine
          ? `<button class="primary" data-act="edit-bio">Edit bio</button>
             <label class="ghost fileBtn">📷 Add photo${''}<input type="file" accept="image/*" hidden data-up="photo"></label>
             <label class="ghost fileBtn">🎬 Add clip<input type="file" accept="video/*" hidden data-up="clip"></label>`
          : `<button class="primary" data-act="follow">${p.i_follow ? 'Following ✓' : 'Follow'}</button>
             <button class="${p.can_dm ? 'ghost' : 'ghost off'}" data-act="message" ${p.can_dm ? '' : 'disabled'}>✉️ Message</button>
             <button class="ghost" data-act="block">${p.blocked_by_me ? 'Unblock' : 'Block'}</button>
             <button class="ghost danger" data-act="report">Report</button>`}
      </div>
      <h3 class="mediaHead">Photos &amp; clips</h3>
      <div class="mediaGrid" id="mediaGrid"></div>
    `;

    // profile picture: avatar_url when set, else the styled initial
    const grid = $('#mediaGrid');
    if (!p.media.length) grid.innerHTML = '<p class="muted">Nothing posted yet.</p>';
    for (const m of p.media) {
      const cell = document.createElement('div');
      cell.className = 'mediaCell';
      grid.appendChild(cell);
      void this.renderMediaCell(cell, m, mine);
    }

    body.querySelector('[data-act="edit-bio"]')?.addEventListener('click', () => void this.editBio());
    body.querySelectorAll('[data-up]').forEach((el) => el.addEventListener('change', () => {
      const input = el as HTMLInputElement;
      const kind = input.dataset.up === 'clip' ? 'clip' : 'photo';
      const file = input.files?.[0];
      if (file) void this.upload(kind, file);
      input.value = '';
    }));
    body.querySelector('[data-act="follow"]')?.addEventListener('click', async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      b.disabled = true;
      const r = await this.host.social.follow(p.username, !p.i_follow);
      b.disabled = false;
      if (!r.ok) { this.host.toast(r.message ?? 'Could not update'); return; }
      p.i_follow = !p.i_follow;
      p.followers += p.i_follow ? 1 : -1;
      b.textContent = p.i_follow ? 'Following ✓' : 'Follow';
      this.host.toast(p.i_follow ? `You follow ${p.display_name}` : `Unfollowed ${p.display_name}`);
    });
    body.querySelector('[data-act="message"]')?.addEventListener('click', () => void this.message(p.username));
    body.querySelector('[data-act="block"]')?.addEventListener('click', async () => {
      if (!p.blocked_by_me && !this.host.confirm(`Block @${p.username}? They will not be able to message you.`)) return;
      const r = await this.host.social.block(p.username, !p.blocked_by_me);
      if (!r.ok) { this.host.toast(r.message ?? 'Could not update'); return; }
      p.blocked_by_me = !p.blocked_by_me;
      p.can_dm = !p.blocked_by_me;
      this.host.toast(p.blocked_by_me ? `@${p.username} blocked` : `@${p.username} unblocked`);
      await this.renderProfile();
    });
    body.querySelector('[data-act="report"]')?.addEventListener('click', async () => {
      const reasons: ReportReason[] = ['spam', 'abuse', 'cheat', 'inappropriate', 'other'];
      const detail = await this.host.ask('Report @' + p.username, 'Reason: spam / abuse / cheat / inappropriate / other. The moderators review every report.', 'Reason + details', false);
      if (!detail) return;
      const reason = (reasons.find((r) => detail.toLowerCase().startsWith(r)) ?? 'other') as ReportReason;
      const r = await this.host.social.report(p.username, reason, detail);
      this.host.toast(r.ok ? 'Reported. Thank you — the moderators will review it.' : (r.message ?? 'Could not report'));
    });
  }

  private async renderMediaCell(cell: HTMLElement, m: MediaItem, mine: boolean) {
    try {
      const url = await this.host.social.mediaUrl(m.path);
      if (m.kind === 'clip') {
        cell.innerHTML = `<video src="${url}" controls playsinline preload="metadata"></video>${mine ? '<button class="del" title="Delete">×</button>' : ''}`;
      } else {
        cell.innerHTML = `<img src="${url}" alt="${esc(m.caption)}" loading="lazy">${mine ? '<button class="del" title="Delete">×</button>' : ''}`;
      }
    } catch {
      cell.innerHTML = `<div class="muted">media</div>`;
    }
    if (mine) cell.querySelector('.del')?.addEventListener('click', async () => {
      if (!this.host.confirm('Delete this from your page?')) return;
      const r = await this.host.social.deleteMedia(m.id);
      if (r.ok) { this.host.toast('Deleted'); await this.renderProfile(); }
      else this.host.toast(r.message ?? 'Could not delete');
    });
    if (m.caption) cell.title = m.caption;
  }

  private async editBio() {
    const p = this.page;
    if (!p) return;
    const v = await this.host.ask('Your biography', 'Up to 280 characters. This is public.', p.bio || 'Tell the city about yourself', false);
    if (v === null) return;
    // profile bio lives in the account profile (same column the HUD saves)
    const { cloud } = await import('../net/supabase');
    try {
      if (cloud.signedIn) await cloud.updateProfile({ bio: v.slice(0, 280) });
      p.bio = v.slice(0, 280);
      await this.renderProfile();
      this.host.toast('Bio saved');
    } catch (e: any) { this.host.toast(e?.message ?? 'Could not save'); }
  }

  private async upload(kind: 'photo' | 'clip', file: File) {
    this.host.toast(kind === 'photo' ? 'Uploading photo…' : 'Uploading clip…');
    const r = await this.host.social.uploadMedia(kind, file, '');
    if (!r.ok) { this.host.toast(r.message ?? 'Upload failed'); return; }
    this.host.toast(kind === 'photo' ? 'Photo added to your page 📷' : 'Clip added to your page 🎬');
    if (this.page) {
      try { this.page = await this.host.social.profilePage(this.page.username); } catch { /* keep old */ }
      await this.renderProfile();
    }
  }

  /* ------------------------------------------------------------------ DMs */

  /** Open (or create) the conversation with a citizen. */
  async message(username: string) {
    const r = await this.host.social.dmStart(username);
    if (!r.ok || !r.conversation_id) { this.host.toast(r.message ?? 'Could not open the conversation'); return; }
    this.openConv = r.conversation_id;
    this.openThread = { conversation_id: r.conversation_id, username: username.toLowerCase(), display_name: username, avatar_url: null, last_message: null, last_at: '', unread: 0 };
    this.host.openPanel('dm');
  }

  /** Someone wrote to me: badge + toast + live update. */
  onIncoming(thread: Thread) {
    this.refreshBadge();
    this.host.toast(`✉️ ${thread.display_name}: ${thread.last_message ?? 'sent you something'}`, 5000);
    if (this.openConv && thread.conversation_id === this.openConv && $('#dmBody').offsetParent) {
      void this.loadThread(this.openThread ?? thread);
    }
  }

  async refreshBadge() {
    try {
      const ts = await this.host.social.dmThreads();
      this.threads = ts;
      const unread = ts.reduce((n, t) => n + (t.unread ?? 0), 0);
      const badge = $('#dmBadge');
      if (badge) {
        badge.textContent = unread > 9 ? '9+' : String(unread);
        badge.classList.toggle('hidden', unread === 0);
      }
    } catch { /* offline / signed out */ }
  }

  private async renderDm() {
    const body = $('#dmBody');
    if (this.openConv) {
      await this.loadThread(this.openThread ?? { conversation_id: this.openConv, username: this.openConv, display_name: this.openConv, avatar_url: null, last_message: null, last_at: '', unread: 0 });
      return;
    }
    body.innerHTML = '<p class="muted">Loading conversations…</p>';
    await this.refreshBadge();
    const ts = this.threads;
    if (!ts.length) {
      body.innerHTML = '<p class="muted">No conversations yet. Walk up to a citizen, tap <strong>Talk</strong> or open their page and press <strong>Message</strong>.</p>';
      return;
    }
    body.innerHTML = `<div class="threadList" id="threadList"></div>`;
    const list = $('#threadList');
    for (const t of ts) {
      const row = document.createElement('button');
      row.className = 'threadRow';
      row.innerHTML = `
        <div class="avatarMini">${esc(t.display_name.charAt(0).toUpperCase())}</div>
        <div class="threadMeta"><strong>${esc(t.display_name)}</strong><small>@${esc(t.username)}</small>
          <p>${esc(t.last_message ?? 'Say something…')}</p></div>
        ${t.unread ? `<span class="pillBadge">${t.unread > 9 ? '9+' : t.unread}</span>` : ''}`;
      row.addEventListener('click', () => {
        this.openConv = t.conversation_id;
        this.openThread = t;
        void this.renderDm();
      });
      list.appendChild(row);
    }
  }

  private async loadThread(t: Thread) {
    const body = $('#dmBody');
    const c = await this.host.social.profilePage(t.username).catch(() => null);
    const name = c?.display_name ?? t.display_name;
    const canSend = c?.can_dm ?? true;
    body.innerHTML = `
      <div class="chatHead">
        <button class="ghost" id="chatBack">←</button>
        <div class="avatarMini">${esc(name.charAt(0).toUpperCase())}</div>
        <div><strong>${esc(name)}</strong><small>@${esc(t.username)}</small></div>
      </div>
      <div class="chatLog" id="chatLog"></div>
      <div class="chatComposer">
        <label class="ghost fileBtn" title="Attach a photo">📎<input type="file" accept="image/*" hidden id="chatAttach"></label>
        <input id="chatInput" maxlength="1000" placeholder="${canSend ? 'Write a private message…' : 'You cannot message this citizen'}" ${canSend ? '' : 'disabled'} autocomplete="off" />
        <button class="primary" id="chatSend" ${canSend ? '' : 'disabled'}>SEND</button>
      </div>
      <div class="attachChip hidden" id="attachChip">📎 photo attached <button class="ghost" id="attachClear">×</button></div>`;
    $('#chatBack').addEventListener('click', () => { this.openConv = null; this.openThread = null; void this.renderDm(); });

    const log = $('#chatLog');
    this.msgs = await this.host.social.dmHistory(t.conversation_id);
    for (const m of this.msgs) log.appendChild(await this.bubble(m));
    log.scrollTop = log.scrollHeight;
    await this.host.social.dmMarkRead(t.conversation_id);
    this.refreshBadge();

    const input = $('#chatInput') as HTMLInputElement;
    const send = async () => {
      const text = input.value.trim();
      if (!text && !this.pendingAttach) return;
      input.value = '';
      const media = this.pendingAttach;
      this.pendingAttach = null;
      $('#attachChip').classList.add('hidden');
      const r = await this.host.social.dmSend(t.conversation_id, text, media);
      if (!r.ok) { this.host.toast(r.message ?? 'Message not sent'); return; }
      const at = new Date().toISOString();
      this.msgs.push({ id: 'local-' + at, mine: true, body: text, media_path: media, created_at: at, read_at: at });
      log.appendChild(await this.bubble(this.msgs[this.msgs.length - 1]));
      log.scrollTop = log.scrollHeight;
    };
    $('#chatSend').addEventListener('click', () => void send());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void send(); });
    const attach = $('#chatAttach') as HTMLInputElement;
    attach.addEventListener('change', () => {
      const file = attach.files?.[0];
      attach.value = '';
      if (!file) return;
      void (async () => {
        const up = await this.host.social.attachDmPhoto(t.conversation_id, file);
        if (!up.ok || !up.path) { this.host.toast(up.message ?? 'Attachment failed'); return; }
        this.pendingAttach = up.path;
        $('#attachChip').classList.remove('hidden');
      })();
    });
    $('#attachClear').addEventListener('click', () => { this.pendingAttach = null; $('#attachChip').classList.add('hidden'); });
    if (window.matchMedia('(pointer: coarse)').matches) $('#chatInput').setAttribute('inputmode', 'text');
  }

  private async bubble(m: Message): Promise<HTMLElement> {
    const el = document.createElement('div');
    el.className = 'chatBubble ' + (m.mine ? 'mine' : 'theirs');
    let mediaHtml = '';
    if (m.media_path) {
      const url = m.media_url ?? await this.host.social.mediaUrl(m.media_path).catch(() => '');
      if (url) mediaHtml = `<img class="chatMedia" src="${url}" alt="attachment" />`;
    }
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `${mediaHtml}${m.body ? `<p>${esc(m.body)}</p>` : ''}<small>${time}</small>`;
    return el;
  }
}
