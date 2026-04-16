const JDL_API = 'https://api.jobdatalake.com';

export class JDLClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async request(path: string, params: Record<string, string> = {}): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const url = `${JDL_API}${path}${qs ? '?' + qs : ''}`;

    const res = await fetch(url, {
      headers: { 'X-API-Key': this.apiKey },
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401) throw new Error('Invalid JDL API key. Get one at https://www.jobdatalake.com');
      if (res.status === 402) throw new Error('Insufficient credits. Top up at https://www.jobdatalake.com/dashboard/billing');
      if (res.status === 429) throw new Error('Rate limit exceeded. Wait a moment and try again.');
      throw new Error(`JDL API error ${res.status}: ${body}`);
    }

    return res.json();
  }

  async searchJobs(params: Record<string, string>) {
    return this.request('/v1/jobs', params);
  }

  async getJob(handle: string) {
    return this.request(`/v1/jobs/${encodeURIComponent(handle)}`);
  }

  async getCompany(handle: string) {
    return this.request(`/v1/companies/${encodeURIComponent(handle)}`);
  }
}
