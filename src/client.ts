const JDL_API = 'https://api.jobdatalake.com';

export interface JDLResponse {
  data: any;
  mcpRemaining?: number;
}

export class JDLClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async request(path: string, params: Record<string, string> = {}): Promise<JDLResponse> {
    const qs = new URLSearchParams(params).toString();
    const url = `${JDL_API}${path}${qs ? '?' + qs : ''}`;

    const res = await fetch(url, {
      headers: { 'X-API-Key': this.apiKey },
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401) throw new Error('Invalid JDL API key. Get one at https://www.jobdatalake.com');
      if (res.status === 402) throw new Error('Insufficient credits. Top up at https://www.jobdatalake.com/dashboard/billing');
      if (res.status === 429) {
        // Check if it's MCP daily limit
        if (body.includes('Daily limit')) {
          throw new Error('Daily free limit reached (500/day). Get unlimited access with your own API key at https://www.jobdatalake.com');
        }
        throw new Error('Rate limit exceeded. Wait a moment and try again.');
      }
      throw new Error(`JDL API error ${res.status}: ${body}`);
    }

    const mcpRemainingHeader = res.headers.get('X-MCP-Remaining');
    const mcpRemaining = mcpRemainingHeader ? parseInt(mcpRemainingHeader, 10) : undefined;

    return {
      data: await res.json(),
      mcpRemaining,
    };
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
