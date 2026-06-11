import type { LoginCredentials, RegisterData, User } from '@/types/auth';
import type { Session } from '@/types/chat';
import type { CodingProblem, RunResult } from '@/types/coding';

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
  async transcribe(audioBlob: Blob, token?: string): Promise<{ text: string }> {
    const formData = new FormData();
    formData.append('file', audioBlob, 'recording.webm');

    const response = await fetch(`${API_URL}/chat/transcribe`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: formData,
    });

    if (!response.ok) {
      throw new Error('Transcription failed');
    }

    return response.json();
  },
  async synthesize(text: string, token?: string): Promise<Blob> {
    const response = await fetch(`${API_URL}/chat/synthesize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error('Synthesis failed');
    }

    return response.blob();
  },
};

export const codingApi = {
  async getProblem(problemId: string, token?: string): Promise<CodingProblem> {
    return apiRequest('GET', `/coding/problems/${problemId}`, undefined, token);
  },
  async getSessionProblems(sessionId: string, token?: string): Promise<CodingProblem[]> {
    return apiRequest('GET', `/coding/sessions/${sessionId}/problems`, undefined, token);
  },
  async run(
    data: { problemId: string; language: string; code: string },
    token?: string
  ): Promise<RunResult> {
    return apiRequest(
      'POST',
      '/coding/run',
      { problem_id: data.problemId, language: data.language, code: data.code },
      token
    );
  },
  async submit(
    data: { sessionId: string; problemId: string; language: string; code: string },
    token?: string
  ): Promise<RunResult> {
    return apiRequest(
      'POST',
      '/coding/submit',
      {
        session_id: data.sessionId,
        problem_id: data.problemId,
        language: data.language,
        code: data.code,
      },
      token
    );
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
      let detail: unknown;
      try {
        detail = await response.json();
      } catch {
        detail = await response.text();
      }
      const message =
        typeof detail === 'object' && detail !== null && 'detail' in detail
          ? String((detail as { detail: unknown }).detail)
          : `Failed to create interview (status ${response.status})`;
      throw new ApiError(response.status, message, detail);
    }

    return response.json();
  },

  async startInterview(
    data: { role: string; interviewType: string; difficulty: string },
    token: string
  ): Promise<{ interview_id: string }> {
    return apiRequest('POST', '/interview/start', {
      role: data.role,
      interview_type: data.interviewType,
      difficulty: data.difficulty,
    }, token);
  },

  async getSessions(token: string): Promise<Session[]> {
    return apiRequest('GET', '/interview/sessions', undefined, token);
  },

  async getSession(interviewId: string, token: string): Promise<Session> {
    return apiRequest('GET', `/interview/${interviewId}`, undefined, token);
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


