import { validateState } from './model.js';

function cloudError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.isCloudError = true;
  return error;
}
function cloudStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}
function cloudSession(data) {
  if (!data || typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token || !data.user || typeof data.user.id !== 'string') return null;
  const expiresAt = Number(data.expires_at || (Date.now() / 1000 + Number(data.expires_in || 3600)));
  if (!Number.isFinite(expiresAt)) return null;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    user: { id: data.user.id, email: typeof data.user.email === 'string' ? data.user.email : '' },
  };
}
function cloudEnvelope(data) {
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0) throw cloudError('response', 'База вернула неверный ответ. Проверьте установку SQL-схемы.');
  try { return { state: validateState(data.state), revision: data.revision }; }
  catch { throw cloudError('response', 'В базе найдены некорректные данные журнала.'); }
}

export function validateCloudConfig({ url, key }) {
    let parsed;
    try { parsed = new URL(url); } catch { throw cloudError('config', 'Укажите корректный адрес проекта Supabase.'); }
    if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw cloudError('config', 'Адрес Supabase должен содержать только HTTPS-адрес проекта.');
    if (typeof key !== 'string' || !key.trim() || key.startsWith('sb_secret_')) throw cloudError('config', 'Нужен публичный publishable или anon ключ Supabase. Секретный ключ использовать нельзя.');
    key = key.trim();
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
      let claims;
      try { claims = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { /* Reject malformed or private keys below. */ }
      if (key.split('.').length !== 3 || claims?.role !== 'anon') throw cloudError('config', 'Нужен публичный publishable или anon ключ Supabase. Секретный ключ использовать нельзя.');
    }
    return { url: parsed.origin, key };
}

export class CloudClient {
  constructor({ url, key, storage = cloudStorage(), fetchImpl = globalThis.fetch }) {
    const config = validateCloudConfig({ url, key });
    this.url = config.url;
    this.key = config.key;
    this.storage = storage;
    // Native browser fetch rejects arbitrary receivers. Invoke the supplied function directly.
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.storageKey = `classroom.auth.${this.url}`;
    this.generation = 0;
    this.refreshing = null;
    this.session = null;
    try { this.session = cloudSession(JSON.parse(this.storage?.getItem(this.storageKey) || 'null')); } catch { /* Storage is optional; keep session in memory. */ }
  }

  _setSession(session) {
    this.session = session;
    try {
      if (session) this.storage?.setItem(this.storageKey, JSON.stringify(session));
      else this.storage?.removeItem(this.storageKey);
    } catch { /* Restricted previews can still use a session until reload. */ }
  }

  _checkGeneration(generation) {
    if (generation !== this.generation) throw cloudError('cancelled', 'Аккаунт изменился. Повторите действие.');
  }

  async _request(path, body, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.fetchImpl(`${this.url}${path}`, {
        method: 'POST',
        headers: { apikey: this.key, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try { if (text) data = JSON.parse(text); } catch {
        throw cloudError('response', 'Сервис вернул неверный ответ. Проверьте адрес проекта.');
      }
      if (!response.ok) {
        if (data?.code === '40001' || data?.message === 'journal_conflict') throw cloudError('conflict', 'Журнал уже изменён на другом устройстве. Обновите данные и повторите изменение.');
        if (response.status === 401 || response.status === 403) throw cloudError('auth', 'Не удалось подтвердить вход. Войдите в аккаунт снова.');
        if (data?.error_code === 'invalid_credentials' || data?.code === 'invalid_credentials') throw cloudError('auth', 'Неверная почта или пароль.');
        if (['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'invalid_grant'].includes(data?.error_code || data?.code || data?.error)) throw cloudError('auth', 'Сессия истекла. Войдите в аккаунт снова.');
        if (data?.code === 'PGRST202' || data?.code === '42883') throw cloudError('schema', 'Облачная база ещё не настроена. Выполните SQL-схему из репозитория.');
        if (response.status === 429) throw cloudError('rate_limit', 'Слишком много запросов. Подождите немного и повторите.');
        throw cloudError('service', 'Операция не выполнена. Проверьте настройки Supabase и доступность сервиса.');
      }
      return data;
    } catch (error) {
      if (error.isCloudError) throw error;
      throw cloudError('network', controller.signal.aborted ? 'Сервер не ответил вовремя. Проверьте интернет и повторите.' : 'Нет соединения с облачной базой. Проверьте интернет и повторите.');
    } finally { clearTimeout(timer); }
  }

  async signIn(email, password) {
    const generation = ++this.generation;
    this.refreshing = null;
    this._setSession(null);
    const data = await this._request('/auth/v1/token?grant_type=password', { email: email.trim(), password });
    this._checkGeneration(generation);
    const session = cloudSession(data);
    if (!session) throw cloudError('response', 'Сервис не вернул данные входа. Повторите попытку.');
    this._setSession(session);
    return session;
  }

  async signUp(email, password) {
    const generation = ++this.generation;
    this.refreshing = null;
    this._setSession(null);
    const data = await this._request('/auth/v1/signup', { email: email.trim(), password });
    this._checkGeneration(generation);
    if (!data || (!data.user?.id && !data.id)) throw cloudError('response', 'Сервис не подтвердил регистрацию. Повторите попытку.');
    const session = cloudSession(data);
    this._setSession(session);
    // A null session means email confirmation is required. Never pretend it is signed in.
    return session;
  }

  async signOut() {
    const token = this.session?.access_token;
    ++this.generation;
    this.refreshing = null;
    this._setSession(null);
    if (token) await this._request('/auth/v1/logout?scope=local', {}, token);
  }

  async _refresh(generation) {
    this._checkGeneration(generation);
    if (!this.session) throw cloudError('auth', 'Войдите в аккаунт для синхронизации.');
    if (this.refreshing?.generation === generation) return this.refreshing.promise;
    const refreshToken = this.session.refresh_token;
    const promise = (async () => {
      try {
        const data = await this._request('/auth/v1/token?grant_type=refresh_token', { refresh_token: refreshToken });
        this._checkGeneration(generation);
        const session = cloudSession(data);
        if (!session) throw cloudError('auth', 'Сессия истекла. Войдите снова.');
        this._setSession(session);
        return session;
      } catch (error) {
        if (generation === this.generation && error.code === 'auth') this._setSession(null);
        throw error;
      } finally {
        if (this.refreshing?.generation === generation) this.refreshing = null;
      }
    })();
    this.refreshing = { generation, promise };
    return promise;
  }

  async _rpc(name, body) {
    const generation = this.generation;
    if (!this.session) throw cloudError('auth', 'Войдите в аккаунт для синхронизации.');
    if (this.session.expires_at <= Date.now() / 1000 + 30) await this._refresh(generation);
    this._checkGeneration(generation);
    const usedToken = this.session.access_token;
    let data;
    try { data = await this._request(`/rest/v1/rpc/${name}`, body, usedToken); }
    catch (error) {
      this._checkGeneration(generation);
      if (error.code !== 'auth') throw error;
      // Another concurrent RPC may already have refreshed this token.
      if (this.session?.access_token === usedToken) await this._refresh(generation);
      this._checkGeneration(generation);
      if (!this.session) throw error;
      try { data = await this._request(`/rest/v1/rpc/${name}`, body, this.session.access_token); }
      catch (retryError) {
        this._checkGeneration(generation);
        if (retryError.code === 'auth') this._setSession(null);
        throw retryError;
      }
    }
    this._checkGeneration(generation);
    return cloudEnvelope(data);
  }

  load() { return this._rpc('load_journal', {}); }
  save(state, revision) {
    const clean = validateState(state);
    if (!Number.isSafeInteger(revision) || revision < 0) return Promise.reject(cloudError('revision', 'Неверная версия журнала. Сначала обновите данные.'));
    return this._rpc('save_journal', { p_state: clean, p_expected_revision: revision });
  }
}
