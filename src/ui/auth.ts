/**
 * Sign in / create account screen. Shown only when the game runs with a
 * Supabase backend and nobody is signed in. Email + password accounts with a
 * unique username, display name and explicit terms / privacy / age consent.
 */
import { cloud } from '../net/supabase';

type Mode = 'signin' | 'signup' | 'forgot' | 'verify' | 'recover';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export class AuthScreen {
  private root = document.getElementById('auth')!;
  private mode: Mode = 'signin';
  private pendingEmail = '';
  private availTimer = 0;

  /** Resolves once a user is signed in (and the session is in `cloud`). */
  show(initial: Mode = 'signin'): Promise<void> {
    this.mode = initial;
    this.root.classList.remove('hidden');
    document.getElementById('loading')?.classList.add('done');
    return new Promise((resolve) => {
      const done = () => { this.root.classList.add('hidden'); this.root.innerHTML = ''; resolve(); };
      this.render(done);
    });
  }

  private render(done: () => void) {
    const r = this.root;
    const tabs = `<div class="tabs"><button data-m="signin" class="${this.mode === 'signin' ? 'on' : ''}">SIGN IN</button><button data-m="signup" class="${this.mode === 'signup' ? 'on' : ''}">CREATE ACCOUNT</button></div>`;
    const head = `<div class="brand"><span class="mark">G</span><span class="brandText">GISTCITY<small>YOUR CITY. YOUR STORY.</small></span></div>`;
    let body = '';
    if (this.mode === 'signin') body = `${tabs}
      <label>Email</label><input type="email" id="aEmail" autocomplete="email" inputmode="email" placeholder="you@gmail.com" />
      <label>Password</label><input type="password" id="aPass" autocomplete="current-password" placeholder="Your password" />
      <div class="err" id="aErr"></div>
      <button class="primary" id="aGo">ENTER THE CITY</button>
      <div class="links"><button data-m="forgot">Forgot password?</button><button data-m="verify">Need a verification email?</button></div>`;
    else if (this.mode === 'signup') body = `${tabs}
      <label>Username <i id="uState"></i></label><input type="text" id="aUser" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" placeholder="3–20 letters, numbers, _" />
      <label>Display name</label><input type="text" id="aName" autocomplete="nickname" maxlength="24" placeholder="How people see you in the city" />
      <label>Email</label><input type="email" id="aEmail" autocomplete="email" inputmode="email" placeholder="you@gmail.com" />
      <label>Password</label><input type="password" id="aPass" autocomplete="new-password" placeholder="At least 8 characters" />
      <label>Confirm password</label><input type="password" id="aPass2" autocomplete="new-password" placeholder="Type it again" />
      <label class="check"><input type="checkbox" id="aAge" /><span>I am 16 or older.</span></label>
      <label class="check"><input type="checkbox" id="aTos" /><span>I accept the <a href="terms.html" target="_blank" rel="noopener">Terms of Use</a> and the <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
      <div class="err" id="aErr"></div>
      <button class="primary" id="aGo">CREATE MY ACCOUNT</button>`;
    else if (this.mode === 'forgot') body = `<p class="muted">Enter your email and we will send a link to set a new password.</p>
      <label>Email</label><input type="email" id="aEmail" autocomplete="email" inputmode="email" value="${esc(this.pendingEmail)}" />
      <div class="err" id="aErr"></div>
      <button class="primary" id="aGo">SEND RESET LINK</button>
      <div class="links"><button data-m="signin">← Back to sign in</button></div>`;
    else if (this.mode === 'verify') body = `<div class="notice">Check <b>${esc(this.pendingEmail || 'your inbox')}</b> for a verification link. Open it, then sign in here. Also check spam / promotions.</div>
      <label>Email</label><input type="email" id="aEmail" autocomplete="email" inputmode="email" value="${esc(this.pendingEmail)}" />
      <div class="err" id="aErr"></div>
      <button class="primary" id="aGo">RESEND VERIFICATION EMAIL</button>
      <div class="links"><button data-m="signin">← Sign in</button></div>`;
    else if (this.mode === 'recover') body = `<p class="muted">Choose a new password for ${esc(cloud.email || 'your account')}.</p>
      <label>New password</label><input type="password" id="aPass" autocomplete="new-password" placeholder="At least 8 characters" />
      <label>Confirm password</label><input type="password" id="aPass2" autocomplete="new-password" />
      <div class="err" id="aErr"></div>
      <button class="primary" id="aGo">SAVE PASSWORD</button>`;
    r.innerHTML = `<div class="authCard">${head}<h1>${this.mode === 'signup' ? 'Become a citizen' : this.mode === 'recover' ? 'Reset password' : this.mode === 'forgot' ? 'Forgot password' : this.mode === 'verify' ? 'Verify your email' : 'Welcome back'}</h1>
      <p class="muted">A persistent 3D city where you live, hustle, eat, rest and gist with real people.</p>${body}
      <p class="muted" style="margin-top:16px">Your password is only ever sent to the authentication server over HTTPS; this app holds no secret keys.</p><p class="muted" style="text-align:center;letter-spacing:2px;font-size:10px">POWERED BY RIEL INC.</p></div>`;

    const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => r.querySelector('#' + id) as T;
    const err = (m: string) => { const e = r.querySelector('#aErr'); if (e) e.textContent = m; };
    r.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) => b.addEventListener('click', () => { this.pendingEmail = ($('aEmail') as HTMLInputElement | null)?.value?.trim() || this.pendingEmail; this.mode = b.dataset.m as Mode; this.render(done); }));
    const go = $<HTMLButtonElement>('aGo');
    r.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go.click(); }));

    if (this.mode === 'signup') {
      const u = $('aUser'), st = $<HTMLElement>('uState');
      u.addEventListener('input', () => {
        u.value = u.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
        clearTimeout(this.availTimer);
        if (!USERNAME_RE.test(u.value)) { st.textContent = u.value ? '3–20 chars: a-z 0-9 _' : ''; st.className = u.value ? 'bad' : ''; return; }
        st.textContent = 'checking…'; st.className = '';
        this.availTimer = window.setTimeout(async () => {
          try { const ok = await cloud.usernameAvailable(u.value); st.textContent = ok ? 'available ✓' : 'taken'; st.className = ok ? 'ok' : 'bad'; }
          catch { st.textContent = ''; }
        }, 350);
      });
    }

    go.addEventListener('click', async () => {
      err(''); go.disabled = true;
      try {
        if (this.mode === 'signin') {
          const email = $('aEmail').value.trim(), pass = $('aPass').value;
          if (!email || !pass) throw new Error('Enter your email and password.');
          this.pendingEmail = email;
          try { await cloud.signIn(email, pass); }
          catch (e: any) {
            const m = String(e?.message ?? '');
            if (/not confirmed/i.test(m)) { this.mode = 'verify'; this.render(done); return; }
            throw new Error(/invalid/i.test(m) ? 'Wrong email or password.' : m);
          }
          done();
        } else if (this.mode === 'signup') {
          const username = $('aUser').value.trim(), displayName = $('aName').value.trim(), email = $('aEmail').value.trim(), pass = $('aPass').value, pass2 = $('aPass2').value;
          if (!USERNAME_RE.test(username)) throw new Error('Username: 3–20 lowercase letters, numbers or underscores.');
          if (!displayName) throw new Error('Choose a display name.');
          if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address.');
          if (pass.length < 8) throw new Error('Password must be at least 8 characters.');
          if (pass !== pass2) throw new Error('Passwords do not match.');
          if (!$('aAge').checked) throw new Error('You must be 16 or older to join GistCity.');
          if (!$('aTos').checked) throw new Error('Please accept the Terms of Use and Privacy Policy.');
          if (!(await cloud.usernameAvailable(username))) throw new Error('That username is taken.');
          this.pendingEmail = email;
          const { needsVerification } = await cloud.signUp({ username, displayName, email, password: pass, tos: true, privacy: true, age: true });
          if (needsVerification) { this.mode = 'verify'; this.render(done); return; }
          done();
        } else if (this.mode === 'forgot') {
          const email = $('aEmail').value.trim(); if (!email) throw new Error('Enter your email.');
          await cloud.resetPassword(email);
          err('Reset link sent — check your inbox.');
        } else if (this.mode === 'verify') {
          const email = $('aEmail').value.trim(); if (!email) throw new Error('Enter your email.');
          await cloud.resendVerification(email);
          err('Verification email sent.');
        } else if (this.mode === 'recover') {
          const pass = $('aPass').value, pass2 = $('aPass2').value;
          if (pass.length < 8) throw new Error('Password must be at least 8 characters.');
          if (pass !== pass2) throw new Error('Passwords do not match.');
          await cloud.updatePassword(pass);
          done();
        }
      } catch (e: any) {
        const m = String(e?.message ?? '');
        err(/Failed to fetch|NetworkError|Load failed/i.test(m) ? "Can't reach the GistCity server. Check your connection and try again." : m || 'Something went wrong. Try again.');
      }
      go.disabled = false;
    });
  }
}
