import type { LoginCredentials, RegisterData, User } from '@/types/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let detail: unknown;
    try {
      detail = await response.json();
    } catch {
      detail = await response.text();
    }

    const message =
      typeof detail === 'object' && detail !== null && 'detail' in detail
        ? String((detail as { detail: unknown }).detail)
        : `Request failed with status ${response.status}`;

    throw new ApiError(response.status, message, detail);
  }

  // Handle empty responses
  const text = await response.text();
  if (!text) return undefined as T;

  return JSON.parse(text) as T;
}

export const authApi = {
  async login(credentials: LoginCredentials): Promise<{ access_token: string; token_type: string }> {
    return apiRequest('POST', '/auth/login', credentials);
  },

  async register(data: RegisterData): Promise<User> {
    return apiRequest('POST', '/auth/register', data);
  },

  async me(token: string): Promise<User> {
    return apiRequest('GET', '/auth/me', undefined, token);
  },
};

export const chatApi = {
  async getFeedback(sessionId: string, token?: string): Promise<string> {
    const response = await apiRequest<{ feedback: string }>(
      'POST',
      `/chat/${sessionId}/feedback`,
      {},
      token
    );
    return response.feedback;
  },
};
