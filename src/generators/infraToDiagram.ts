// Converts engineering infrastructure & CI/CD manifests — Docker Compose
// (`docker-compose.yml` / `compose.yaml`) and GitHub Actions workflows
// (`.github/workflows/*.yml`) — into Mermaid, PlantUML, or Draw.io topology diagrams.

import { convertMermaidToDrawioXml } from '../drawio/mermaidToDrawio';
import { parseSimpleYaml, type DiagramTargetFormat } from './specToDiagram';

function safeId(raw: string, prefix = 'S'): string {
  const clean = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!clean) return prefix;
  return /^\d/.test(clean) ? `${prefix}_${clean}` : clean;
}

function isDatabaseLike(name: string, image: string): boolean {
  return /(?:postgres|mysql|mariadb|mongo|redis|memcached|clickhouse|elastic|opensearch|minio|sqlite|db|database|kafka|rabbitmq|nats)/i.test(
    `${name} ${image}`,
  );
}

export function convertDockerComposeToDiagram(text: string, format: DiagramTargetFormat): string {
  const doc = parseSimpleYaml(text) as Record<string, unknown>;
  if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') {
    throw new Error('Not a valid Docker Compose file (missing "services" map).');
  }

  interface ComposeService {
    name: string;
    id: string;
    image: string;
    ports: string[];
    dependsOn: string[];
    networks: string[];
    volumes: string[];
    isDb: boolean;
  }

  const servicesObj = doc.services as Record<string, unknown>;
  const services: ComposeService[] = [];

  for (const [svcName, rawDef] of Object.entries(servicesObj)) {
    if (!rawDef || typeof rawDef !== 'object') continue;
    const def = rawDef as Record<string, unknown>;
    const image =
      typeof def.image === 'string'
        ? def.image
        : def.build
          ? typeof def.build === 'string'
            ? `build:${def.build}`
            : 'local-build'
          : '';
    const ports = Array.isArray(def.ports) ? def.ports.map(String) : [];

    let dependsOn: string[] = [];
    if (Array.isArray(def.depends_on)) {
      dependsOn = def.depends_on.map(String);
    } else if (def.depends_on && typeof def.depends_on === 'object') {
      dependsOn = Object.keys(def.depends_on as Record<string, unknown>);
    }

    let networks: string[] = [];
    if (Array.isArray(def.networks)) {
      networks = def.networks.map(String);
    } else if (def.networks && typeof def.networks === 'object') {
      networks = Object.keys(def.networks as Record<string, unknown>);
    }

    const volumes = Array.isArray(def.volumes)
      ? def.volumes
          .map(String)
          .map((v) => v.split(':')[0])
          .filter((v) => v && !v.startsWith('.') && !v.startsWith('/'))
      : [];

    services.push({
      name: svcName,
      id: `SVC_${safeId(svcName)}`,
      image,
      ports,
      dependsOn,
      networks,
      volumes,
      isDb: isDatabaseLike(svcName, image),
    });
  }

  if (services.length === 0) {
    throw new Error('No services defined in Docker Compose file.');
  }

  const byId = new Map(services.map((s) => [s.name, s]));

  if (format === 'plantuml') {
    const lines = ['@startuml', 'left to right direction'];
    const anyExposed = services.some((s) => s.ports.length > 0);
    if (anyExposed) {
      lines.push('actor "Host / Client" as HOST');
    }
    for (const s of services) {
      const desc = [s.name, s.image ? `(${s.image})` : ''].filter(Boolean).join('\\n');
      lines.push(`${s.isDb ? 'database' : 'component'} "${desc}" as ${s.id}`);
    }
    const namedVolumes = new Set<string>();
    for (const s of services) {
      s.volumes.forEach((v) => namedVolumes.add(v));
    }
    for (const v of namedVolumes) {
      lines.push(`storage "vol: ${v}" as VOL_${safeId(v)}`);
    }
    for (const s of services) {
      if (s.ports.length > 0) {
        lines.push(`HOST --> ${s.id} : "${s.ports.join(', ')}"`);
      }
      for (const dep of s.dependsOn) {
        const target = byId.get(dep);
        if (target) {
          lines.push(`${s.id} --> ${target.id} : depends_on`);
        }
      }
      for (const v of s.volumes) {
        lines.push(`${s.id} ..> VOL_${safeId(v)}`);
      }
    }
    lines.push('@enduml');
    return `${lines.join('\n')}\n`;
  }

  const mmd = ['flowchart LR'];
  if (services.some((s) => s.ports.length > 0)) {
    mmd.push('  HOST(["Host / External Ports"])');
  }

  // Group by primary network if networks are declared
  const byNet = new Map<string, ComposeService[]>();
  const ungrouped: ComposeService[] = [];
  for (const s of services) {
    if (s.networks.length > 0) {
      const net = s.networks[0];
      const list = byNet.get(net) ?? [];
      list.push(s);
      byNet.set(net, list);
    } else {
      ungrouped.push(s);
    }
  }

  const fmtNode = (s: ComposeService) => {
    const lbl = (s.image ? `${s.name} (${s.image})` : s.name).replace(/"/g, "'");
    return s.isDb ? `${s.id}[("${lbl}")]` : `${s.id}["${lbl}"]`;
  };

  for (const [net, list] of byNet) {
    mmd.push(`  subgraph NET_${safeId(net)}["Network: ${net}"]`);
    for (const s of list) {
      mmd.push(`    ${fmtNode(s)}`);
    }
    mmd.push('  end');
  }
  for (const s of ungrouped) {
    mmd.push(`  ${fmtNode(s)}`);
  }

  const namedVolumes = new Set<string>();
  for (const s of services) s.volumes.forEach((v) => namedVolumes.add(v));
  for (const v of namedVolumes) {
    mmd.push(`  VOL_${safeId(v)}[("Volume: ${v}")]`);
  }

  for (const s of services) {
    if (s.ports.length > 0) {
      mmd.push(`  HOST -->|"${s.ports.join(', ')}"| ${s.id}`);
    }
    for (const dep of s.dependsOn) {
      const target = byId.get(dep);
      if (target) {
        mmd.push(`  ${s.id} --> ${target.id}`);
      }
    }
    for (const v of s.volumes) {
      mmd.push(`  ${s.id} -.-> VOL_${safeId(v)}`);
    }
  }

  const mermaidOut = `${mmd.join('\n')}\n`;
  return format === 'drawio' ? convertMermaidToDrawioXml(mermaidOut) : mermaidOut;
}

export function convertGithubWorkflowToDiagram(text: string, format: DiagramTargetFormat): string {
  const doc = parseSimpleYaml(text) as Record<string, unknown>;
  if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') {
    throw new Error('Not a valid GitHub Actions workflow (missing "jobs" map).');
  }

  const wfName = String(doc.name || 'CI Workflow').replace(/"/g, "'");
  const rawOn = doc.on ?? doc.true;
  let triggers: string[] = [];
  if (typeof rawOn === 'string') {
    triggers = [rawOn];
  } else if (Array.isArray(rawOn)) {
    triggers = rawOn.map(String);
  } else if (rawOn && typeof rawOn === 'object') {
    triggers = Object.keys(rawOn as Record<string, unknown>);
  }
  if (triggers.length === 0) {
    triggers = ['trigger'];
  }

  interface WorkflowJob {
    key: string;
    id: string;
    displayName: string;
    runsOn: string;
    stepCount: number;
    needs: string[];
  }

  const jobsObj = doc.jobs as Record<string, unknown>;
  const jobs: WorkflowJob[] = [];
  for (const [jobKey, rawJob] of Object.entries(jobsObj)) {
    if (!rawJob || typeof rawJob !== 'object') continue;
    const j = rawJob as Record<string, unknown>;
    const needs = Array.isArray(j.needs)
      ? j.needs.map(String)
      : typeof j.needs === 'string'
        ? [j.needs]
        : [];
    const steps = Array.isArray(j.steps) ? j.steps.length : 0;
    jobs.push({
      key: jobKey,
      id: `JOB_${safeId(jobKey)}`,
      displayName: String(j.name || jobKey).replace(/"/g, "'"),
      runsOn: typeof j['runs-on'] === 'string' ? j['runs-on'] : '',
      stepCount: steps,
      needs,
    });
  }

  if (jobs.length === 0) {
    throw new Error('No jobs found in GitHub Actions workflow.');
  }

  const byKey = new Map(jobs.map((j) => [j.key, j]));
  const trigLabel = `on: ${triggers.join(', ')}`;

  if (format === 'plantuml') {
    const lines = ['@startuml', 'left to right direction', `title ${wfName}`, `usecase "${trigLabel}" as TRIGGER`];
    for (const j of jobs) {
      const meta = [j.runsOn, j.stepCount ? `${j.stepCount} steps` : ''].filter(Boolean).join(' · ');
      const lbl = meta ? `${j.displayName}\\n[${meta}]` : j.displayName;
      lines.push(`rectangle "${lbl}" as ${j.id}`);
    }
    for (const j of jobs) {
      if (j.needs.length === 0) {
        lines.push(`TRIGGER --> ${j.id}`);
      } else {
        for (const dep of j.needs) {
          const upstream = byKey.get(dep);
          if (upstream) lines.push(`${upstream.id} --> ${j.id}`);
        }
      }
    }
    lines.push('@enduml');
    return `${lines.join('\n')}\n`;
  }

  const mmd = ['flowchart LR', `  TRIGGER(["${trigLabel}"])`];
  mmd.push(`  subgraph WF["${wfName}"]`);
  for (const j of jobs) {
    const meta = [j.runsOn, j.stepCount ? `${j.stepCount} steps` : ''].filter(Boolean).join(', ');
    const lbl = meta ? `${j.displayName} (${meta})` : j.displayName;
    mmd.push(`    ${j.id}["${lbl}"]`);
  }
  mmd.push('  end');

  for (const j of jobs) {
    if (j.needs.length === 0) {
      mmd.push(`  TRIGGER --> ${j.id}`);
    } else {
      for (const dep of j.needs) {
        const upstream = byKey.get(dep);
        if (upstream) mmd.push(`  ${upstream.id} --> ${j.id}`);
      }
    }
  }

  const mermaidOut = `${mmd.join('\n')}\n`;
  return format === 'drawio' ? convertMermaidToDrawioXml(mermaidOut) : mermaidOut;
}

export function convertInfraToDiagram(text: string, format: DiagramTargetFormat, fileNameHint = ''): string {
  const lower = fileNameHint.toLowerCase();
  const parsed = parseSimpleYaml(text) as Record<string, unknown>;
  if (
    lower.includes('workflow') ||
    (parsed && typeof parsed === 'object' && parsed.jobs && !parsed.services)
  ) {
    return convertGithubWorkflowToDiagram(text, format);
  }
  return convertDockerComposeToDiagram(text, format);
}
