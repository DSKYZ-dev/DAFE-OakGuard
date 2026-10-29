export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchOptions {
  query: string;
  category?: 'earnings' | 'news' | 'risks' | 'analysis' | 'general';
  symbol?: string;
  maxResults?: number;
}

export class WebSearch {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8788') {
    this.baseUrl = baseUrl;
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const { query, category = 'general', symbol, maxResults = 5 } = options;
    try {
      const resp = await fetch(`${this.baseUrl}/api/web-search/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, category, symbol, max_results: maxResults }),
      });
      const data = await resp.json();
      if (data.ok) {
        return data.results.map((r: any) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  async searchEarnings(symbol: string): Promise<SearchResult[]> {
    return this.search({ query: '', category: 'earnings', symbol, maxResults: 5 });
  }

  async searchNews(symbol: string): Promise<SearchResult[]> {
    return this.search({ query: '', category: 'news', symbol, maxResults: 10 });
  }

  async searchRisks(symbol: string): Promise<SearchResult[]> {
    return this.search({ query: '', category: 'risks', symbol, maxResults: 5 });
  }
}
