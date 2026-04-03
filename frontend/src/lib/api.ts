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

export const interviewApi = {
  async createInterview(
    data: {
      resume: File;
      jobDescription: string;
      role: string;
      interviewType: string;
      difficulty: string;
    },
    token: string
  ): Promise<{ interview_id: string }> {
    const formData = new FormData();
    formData.append('resume', data.resume);
    formData.append('job_description', data.jobDescription);
    formData.append('role', data.role);
    formData.append('interview_type', data.interviewType);
    formData.append('difficulty', data.difficulty);

    const response = await fetch(`${API_URL}/interview/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error('Failed to create interview');
    }

    return response.json();
  },

  async getSessions(token: string): Promise<unknown[]> {
    return apiRequest('GET', '/interview/sessions', undefined, token);
  },

  async getSession(sessionId: string, token: string): Promise<unknown> {
    return apiRequest('GET', `/interview/${sessionId}`, undefined, token);
  },

  async downloadResume(interviewId: string, token: string, filename: string) {
    const response = await fetch(`${API_URL}/interview/${interviewId}/resume`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to download resume');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'resume.pdf';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  },
};


