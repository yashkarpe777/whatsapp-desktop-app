// API service for WhatsApp Blast App backend communication

// Normalize bases: ensure they include a single /api suffix and no trailing slash dupes
const withApiSuffix = (u: string): string => {
  try {
    if (!u) return '';
    const trimmed = u.replace(/\/+$/, '');
    if (/\/api$/i.test(trimmed)) return trimmed;
    return `${trimmed}/api`;
  } catch {
    return u as string;
  }
};

// Allow runtime overrides from Electron preload (packaged app)
const runtimeEnv = (typeof window !== 'undefined' && (window as any)?.electronAPI?.env) || {} as { ADMIN_API_BASE_URL?: string; CORE_API_BASE_URL?: string };
const API_BASE_URL_CORE_RAW = runtimeEnv.CORE_API_BASE_URL || import.meta.env?.VITE_API_BASE_URL_CORE || 'http://127.0.0.1:3000';
const API_BASE_URL_ADMIN_RAW = runtimeEnv.ADMIN_API_BASE_URL || import.meta.env?.VITE_API_BASE_URL_ADMIN || API_BASE_URL_CORE_RAW;

export const API_BASE_URL_CORE = withApiSuffix(API_BASE_URL_CORE_RAW);
export const API_BASE_URL_ADMIN = withApiSuffix(API_BASE_URL_ADMIN_RAW);
// Backwards compatibility for existing code that imports API_BASE_URL
export const API_BASE_URL = API_BASE_URL_CORE;

export interface Contact {
  id?: number;
  number: string;
  name?: string;
  status?: 'pending' | 'sent' | 'failed' | 'skipped';
  created_at?: string;
}

export interface Campaign {
  id?: number;
  name: string;
  video_path: string;
  message: string;
  total_contacts: number;
  sent: number;
  failed: number;
  skipped: number;
  status: 'pending' | 'running' | 'completed' | 'paused' | 'failed';
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
  success_rate?: number;
  duration_seconds?: number;
}

export interface CampaignLog {
  id: number;
  campaign_id: number;
  contact_number: string;
  status: 'sent' | 'failed' | 'skipped';
  error_message?: string;
  timestamp: string;
}

export interface DashboardStats {
  total_contacts: number;
  active_campaigns: number;
  total_sent: number;
  success_rate: number;
  recent_campaigns: {
    id: number;
    name: string;
    status: string;
    created_at: string;
    total_contacts: number;
    sent: number;
  }[];
  completed_campaigns: number;
  remaining_coins: number;
  stopped_campaigns: number;
  in_progress_campaigns: number;
}

class ApiService {
  private async request<T>(endpoint: string, options: RequestInit = {}, retries = 3): Promise<T> {
    const isAdminPath = /^\/(coins|admin|auth)/.test(endpoint);
    const base = isAdminPath ? API_BASE_URL_ADMIN : API_BASE_URL_CORE;
    const url = `${base}${endpoint}`;

    const token = localStorage.getItem('token');
    const config: RequestInit = {
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
        ...options.headers,
      },
      ...options,
    };

    // Add timeout to fetch request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    try {
      const response = await fetch(url, { ...config, signal: controller.signal });

      if (!response.ok) {
        let detail = `HTTP error! status: ${response.status}`;
        try {
          const ct = response.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const j = await response.json();
            detail = j?.message || j?.error || detail;
          } else {
            const t = await response.text();
            if (t) detail = t;
          }
        } catch {}

        // Silent refresh-and-retry on auth errors
        if (response.status === 401 || /invalid|expired|jwt/i.test(detail)) {
          const newTok = await this.refreshToken();
          if (newTok) {
            const retryCfg: RequestInit = {
              ...config,
              headers: { ...(config.headers as any), 'Authorization': `Bearer ${newTok}` },
            };
            const retryResp = await fetch(url, retryCfg);
            if (retryResp.ok) return retryResp.json();
          }
        }
        throw new Error(detail);
      }

      clearTimeout(timeoutId);
      return await response.json();
    } catch (error: any) {
      clearTimeout(timeoutId);
      
      // Retry on network errors or timeouts
      if (retries > 0 && (error.name === 'AbortError' || error.message?.includes('fetch') || error.message?.includes('network'))) {
        console.warn(`API request failed, retrying... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
        return this.request<T>(endpoint, options, retries - 1);
      }
      
      console.error(`API request failed: ${endpoint}`, error);
      throw error;
    }
  }

  async uploadContacts(file: File): Promise<{ success: boolean; count: number; message: string }> {
    const formData = new FormData();
    formData.append('file', file);

    const token = localStorage.getItem('token');

    const response = await fetch(`${API_BASE_URL}/contacts/upload`, {
      method: 'POST',
      headers: {
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }

    return await response.json();
  }

  async getContacts(page = 1, limit = 50): Promise<{ contacts: Contact[]; total: number; page: number }> {
    return this.request<{ contacts: Contact[]; total: number; page: number }>(`/contacts?page=${page}&limit=${limit}`);
  }
  async deleteContact(id: number): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/contacts/${id}`, {
      method: 'DELETE',
    });
  }

  // Database configuration API

  // Campaign API
  async createCampaign(data: {
    title: string;
    video_file: File;
    message: string;
    contact_group_id?: number;
    message_delay_seconds?: number;
  }): Promise<{ success: boolean; campaign_id?: number; message?: string }> {
    const formData = new FormData();
    formData.append('title', data.title);
    formData.append('attachment', data.video_file); // Changed from 'video' to 'attachment' to support all file types
    formData.append('message', data.message);
    if (data.contact_group_id) {
      formData.append('contact_group_id', data.contact_group_id.toString());
    }
    if (data.message_delay_seconds !== undefined) {
      formData.append('message_delay_seconds', data.message_delay_seconds.toString());
    }

    const token = localStorage.getItem('token');

    const response = await fetch(`${API_BASE_URL}/campaigns/create`, {
      method: 'POST',
      headers: {
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Campaign creation failed: ${response.status}`);
    }

    return await response.json();
  }

  // Contact Groups API
  async getContactGroups(): Promise<{ success: boolean; groups: { id: number; name: string; contact_count: number; created_at: string }[] }> {
    return this.request('/contacts/groups');
  }

  async deleteContactGroup(groupId: number): Promise<{ success: boolean; message: string }> {
    return this.request(`/contacts/groups/${groupId}`, { method: 'DELETE' });
  }

  async createContactGroup(name: string): Promise<{ success: boolean; group: { id: number; name: string } }> {
    return this.request('/contacts/groups', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  async uploadContactsToGroup(groupId: number, file: File): Promise<{ success: boolean; count: number; message: string; errors: number }> {
    const formData = new FormData();
    formData.append('file', file);

    const token = localStorage.getItem('token');

    const response = await fetch(`${API_BASE_URL}/contacts/groups/${groupId}/upload`, {
      method: 'POST',
      headers: {
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }

    return await response.json();
  }

  async startCampaign(campaignId: number): Promise<{ success: boolean; message: string; needsLogin?: boolean; qr?: string }> {
    return this.request<{ success: boolean; message: string; needsLogin?: boolean; qr?: string }>(`/campaigns/${campaignId}/start`, {
      method: 'POST',
    });
  }

  async pauseCampaign(campaignId: number): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/campaigns/${campaignId}/pause`, {
      method: 'POST',
    });
  }

  async resumeCampaign(campaignId: number): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/campaigns/${campaignId}/resume`, {
      method: 'POST',
    });
  }

  async getCampaigns(): Promise<{ campaigns: Campaign[] }> {
    return this.request<{ campaigns: Campaign[] }>('/campaigns');
  }

  async getCampaign(id: number): Promise<Campaign> {
    return this.request<Campaign>(`/campaigns/${id}`);
  }

  async getCampaignStatus(id: number): Promise<{
    campaign: Campaign;
    progress: {
      total: number;
      sent: number;
      failed: number;
      pending: number;
    };
  }> {
    return this.request(`/campaigns/${id}/status`);
  }

  async deleteCampaign(id: number): Promise<{ success: boolean; message: string }> {
    return this.request(`/campaigns/${id}`, {
      method: 'DELETE',
    });
  }

  async updateCampaignWithMedia(id: number, data: { title?: string; message?: string; video_file?: File; contact_group_id?: number }): Promise<{ success: boolean; campaign: Campaign }> {
    const formData = new FormData();
    if (data.title) formData.append('title', data.title);
    if (data.message) formData.append('message', data.message);
    if (data.video_file) formData.append('attachment', data.video_file); // Changed from 'video' to 'attachment'
    if (typeof data.contact_group_id === 'number') formData.append('contact_group_id', String(data.contact_group_id));

    const token = localStorage.getItem('token');
    const response = await fetch(`${API_BASE_URL}/campaigns/${id}`, {
      method: 'PUT',
      headers: {
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
      body: formData,
    });
    if (!response.ok) throw new Error(`Update failed: ${response.status}`);
    return await response.json();
  }

  async rerunCampaign(id: number, data: { message?: string; video_file?: File }): Promise<{ success: boolean; message: string }> {
    const formData = new FormData();
    if (data.message !== undefined) formData.append('message', data.message);
    if (data.video_file) formData.append('attachment', data.video_file); // Changed from 'video' to 'attachment'

    const token = localStorage.getItem('token');
    const response = await fetch(`${API_BASE_URL}/campaigns/${id}/rerun`, {
      method: 'POST',
      headers: {
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
      body: formData,
    });
    if (!response.ok) {
      let detail = '';
      try { const j = await response.json(); detail = j.message || j.error || ''; } catch {}
      throw new Error(detail || `Rerun failed: ${response.status}`);
    }
    return await response.json();
  }
  // Logs API
  async getCampaignLogs(campaignId: number, page = 1, limit = 50): Promise<{
    logs: CampaignLog[];
    total: number;
    page: number;
  }> {
    return this.request(`/campaigns/${campaignId}/logs?page=${page}&limit=${limit}`);
  }

  async getAllLogs(page = 1, limit = 50): Promise<{
    logs: CampaignLog[] & { campaign_name?: string; contact_number?: string; sent_at?: string };
    total: number;
    page: number;
  }> {
    return this.request(`/campaigns/logs?page=${page}&limit=${limit}`);
  }

  async retryFailedOnly(campaignId: number): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/campaigns/${campaignId}/retry-failed`, {
      method: 'POST',
    });
  }

  // Dashboard API
  async getDashboardStats(): Promise<DashboardStats> {
    return this.request<DashboardStats>('/dashboard');
  }

  // WhatsApp Status API
  // Polls status only; does NOT initialize the client
  async getWhatsAppStatusLight(): Promise<{
    ready: boolean;
    qr?: string;
    number?: string;
    name?: string;
  }> {
    return this.request('/whatsapp/status');
  }

  // Polls QR/init; MAY trigger initialization lazily
  async getWhatsAppStatus(): Promise<{
    ready: boolean;
    qr?: string;
    number?: string;
    name?: string;
  }> {
    return this.request('/whatsapp/qr');
  }

  async whatsappInit(): Promise<{ ready: boolean; qr?: string; number?: string }> {
    return this.request('/whatsapp/init', { method: 'POST' });
  }

  async whatsappCleanProfile(): Promise<{ success: boolean; message: string }> {
    return this.request('/whatsapp/profile', { method: 'DELETE' });
  }

  async disconnectWhatsApp(): Promise<{ success: boolean }> {
    return this.request('/whatsapp/disconnect', {
      method: 'POST',
    });
  }

  // Auth API
  async loginPassword(username: string, password: string): Promise<{ message: string; token: string; user: { id: number; email: string; username: string; role: string; coins: number } }> {
    return this.request('/auth/login-password', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  // Deprecated OTP flows (kept for backward compatibility)
  async login(email: string): Promise<{ message: string }> {
    return this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async verifyOtp(email: string, otp: string): Promise<{ message: string; token: string; user: { id: number; email: string; role: string } }> {
    return this.request('/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ email, otp }),
    });
  }

  // Admin API
  async getUsers(): Promise<{ id: number; email: string; role: string; coins: number }[]> {
    return this.request('/admin/users');
  }

  async creditCoins(userId: number, amount: number): Promise<{ message: string }> {
    return this.request('/admin/credit', {
      method: 'POST',
      body: JSON.stringify({ userId, amount }),
    });
  }

  async createUser(data: { email: string; username: string; role?: 'user' | 'admin'; coins?: number; password?: string }): Promise<{ success: boolean; user: { id: number; email: string; username: string; role: string; coins: number } }> {
    return this.request('/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteUser(userId: number): Promise<{ success: boolean; message: string }> {
    return this.request(`/admin/users/${userId}`, {
      method: 'DELETE',
    });
  }

// Coins API
  async getBalance(): Promise<{ success: boolean; coins: number }> {
    return this.request('/coins/balance');
  }

  async authorizeCoins(required: number): Promise<{ success: boolean; reserved: number }> {
    return this.request('/coins/authorize', {
      method: 'POST',
      body: JSON.stringify({ required }),
    });
  }

  async refundCoins(amount: number): Promise<{ success: boolean; refunded: number }> {
    return this.request('/coins/refund', {
      method: 'POST',
      body: JSON.stringify({ amount }),
    });
  }

  // Auth/me
  async me(): Promise<{ id: number; email: string; username: string; role: string; coins: number }> {
    return this.request('/auth/me');
  }

  // Settings API
  async getSettings(): Promise<{
    whatsapp_number?: string;
    profile_name?: string;
    email?: string;
    app_icon?: string;
  }> {
    return this.request('/settings');
  }

  async updateSettings(data: {
    whatsapp_number?: string;
    profile_name?: string;
    email?: string;
    app_icon?: File;
  }): Promise<{ success: boolean; message: string }> {
    const formData = new FormData();
    if (data.whatsapp_number) formData.append('whatsapp_number', data.whatsapp_number);
    if (data.profile_name) formData.append('profile_name', data.profile_name);
    if (data.email) formData.append('email', data.email);
    if (data.app_icon) formData.append('app_icon', data.app_icon);

    const token = localStorage.getItem('token');

    const response = await fetch(`${API_BASE_URL}/settings`, {
      method: 'PUT',
      headers: {
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Settings update failed: ${response.status}`);
    }

    return await response.json();
  }

  // Local DB config
  async testLocalDbConfig(cfg: { host?: string; port?: number; user?: string; password?: string; database?: string; connectionString?: string; ssl?: boolean }): Promise<{ ok: boolean; message: string }> {
    return this.request('/settings/db/test', {
      method: 'POST',
      body: JSON.stringify(cfg),
    });
  }

  async saveLocalDbConfig(cfg: { host?: string; port?: number; user?: string; password?: string; database?: string; connectionString?: string; ssl?: boolean }): Promise<{ ok: boolean; message: string }> {
    return this.request('/settings/db', {
      method: 'PUT',
      body: JSON.stringify(cfg),
    });
  }

  // Unauthenticated setup endpoints (available before login)
  async testLocalDbConfigSetup(cfg: { host?: string; port?: number; user?: string; password?: string; database?: string; connectionString?: string; ssl?: boolean }): Promise<{ ok: boolean; message?: string }> {
    return this.request<{ ok: boolean; message?: string }>('/settings/test-db-config', {
      method: 'POST',
      body: JSON.stringify(cfg),
    });
  }

  async saveLocalDbConfigSetup(cfg: { host?: string; port?: number; user?: string; password?: string; database?: string; connectionString?: string; ssl?: boolean }): Promise<{ ok?: boolean; message: string }> {
    return this.request<{ ok?: boolean; message: string }>('/settings/save-db-config', {
      method: 'POST',
      body: JSON.stringify(cfg),
    });
  }

  async checkDbStatus(): Promise<{ connected: boolean; configured: boolean; message: string }> {
    return this.request('/settings/db/status', {
      method: 'GET',
    });
  }

  private async refreshToken(): Promise<string | null> {
    try {
      const token = localStorage.getItem('token');
      if (!token) return null;

      const response = await fetch(`${API_BASE_URL_ADMIN}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) return null;

      const data = await response.json();
      if (data.token) {
        localStorage.setItem('token', data.token);
        return data.token;
      }
      return null;
    } catch (error) {
      console.error('Token refresh failed:', error);
      return null;
    }
  }
}

export const apiService = new ApiService();

// Export individual methods for convenience
export const login = apiService.login.bind(apiService);
export const verifyOtp = apiService.verifyOtp.bind(apiService);
export const getUsers = apiService.getUsers.bind(apiService);
export const creditCoins = apiService.creditCoins.bind(apiService);
export const createUser = apiService.createUser.bind(apiService);
export const deleteUser = apiService.deleteUser.bind(apiService);
