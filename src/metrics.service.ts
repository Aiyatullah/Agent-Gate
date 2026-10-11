import { Injectable } from '@nestjs/common';

type Gauge = { help: string; read: () => number | Promise<number> };

const esc = (v: string) => v.replace(/["\\\n]/g, '');

/** Prometheus text-format counters and gauges, exposed at GET /metrics. */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, { name: string; value: number }>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly help = new Map<string, string>();

  describe(name: string, help: string) { this.help.set(name, help); }

  /** Registers a series at 0 so rate()/increase() see the first event. */
  init(name: string, labels: Record<string, string> = {}) { this.inc(name, labels, 0); }

  inc(name: string, labels: Record<string, string> = {}, by = 1) {
    const l = Object.entries(labels);
    const key = `${name}${l.length ? `{${l.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : ''}`;
    const cur = this.counters.get(key) ?? { name, value: 0 };
    cur.value += by;
    this.counters.set(key, cur);
  }

  gauge(name: string, help: string, read: Gauge['read']) { this.gauges.set(name, { help, read }); }

  /** Names of every metric family currently exposed (used by tests to validate alert rules). */
  names() { return new Set([...[...this.counters.values()].map(c => c.name), ...this.gauges.keys(), ...this.help.keys()]); }

  async render() {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const [key, c] of this.counters) {
      if (!seen.has(c.name)) { seen.add(c.name); out.push(`# HELP ${c.name} ${this.help.get(c.name) ?? c.name}`, `# TYPE ${c.name} counter`); }
      out.push(`${key} ${c.value}`);
    }
    for (const [name, g] of this.gauges) {
      let v = 0;
      try { v = await g.read(); } catch { v = Number.NaN; }
      out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`, `${name} ${Number.isNaN(v) ? 'NaN' : v}`);
    }
    return `${out.join('\n')}\n`;
  }
}
