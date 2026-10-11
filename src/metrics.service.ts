import { Injectable } from '@nestjs/common';

/** Minimal Prometheus-style counters, exposed at GET /metrics. */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string> = {}) {
    const key = `${name}${Object.keys(labels).length ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/"/g, '')}"`).join(',')}}` : ''}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  render() {
    return [...this.counters.entries()].map(([k, v]) => `${k} ${v}`).join('\n') + '\n';
  }
}
