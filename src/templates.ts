export const DRAWIO_TEMPLATE = `<mxfile>
  <diagram id="page-1" name="Page-1">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="start" value="Start" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="320" y="120" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="end" value="End" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="320" y="260" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="edge" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="start" target="end">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;

export const MERMAID_TEMPLATE = `flowchart TD
    A[Start] --> B{Is it working?}
    B -- Yes --> C[Great!]
    B -- No --> D[Debug]
    D --> B
`;

export const PLANTUML_TEMPLATE = `@startuml
actor User
participant "VS Code" as Code
participant DrawGraph

User -> Code : edit diagram
Code -> DrawGraph : text changed
DrawGraph --> User : live preview
@enduml
`;

export const DOT_TEMPLATE = `digraph Architecture {
  rankdir=LR;
  node [shape=box, style="rounded,filled", fillcolor="#f8fafc"];

  subgraph cluster_core {
    label="Core Engine";
    Gateway -> Service [label="gRPC"];
    Service -> Cache [style=dashed];
  }

  DB [label="Primary DB", shape=cylinder, fillcolor="#dbeafe"];
  Service -> DB;
}
`;

export const WAVEDROM_TEMPLATE = `{
  "signal": [
    { "name": "CLK",  "wave": "p......." },
    { "name": "CS_N", "wave": "10.....1" },
    { "name": "DATA", "wave": "x3.4.5.x", "data": ["CMD", "ADDR", "PAYLOAD"] }
  ],
  "head": { "text": "Bus Timing Diagram", "tick": 0 }
}
`;

export const WAVEDROM_REG_TEMPLATE = `{
  "reg": [
    { "bits": 1, "name": "EN", "attr": "RW", "type": 4 },
    { "bits": 3, "name": "PRESCALE", "attr": "RW", "type": 5 },
    { "bits": 4 },
    { "bits": 8, "name": "TX_FIFO", "attr": "WO", "type": 3 }
  ],
  "config": { "bits": 16, "lanes": 1 }
}
`;

export const D2_TEMPLATE = `direction: right

client: Web Client {
  shape: rectangle
}

backend: Backend Cluster {
  gateway: API Gateway
  service: Order Service
  cache: Redis Cache {
    shape: cylinder
  }
  gateway -> service: gRPC
  service -> cache: read/write
}

db: Primary Database {
  shape: cylinder
}

client -> backend.gateway: HTTPS
backend.service -> db: SQL
`;

export interface DiagramTemplate {
  id: string;
  kind: 'mermaid' | 'plantuml' | 'drawio' | 'dot' | 'wavedrom' | 'd2';
  label: string;
  detail: string;
  content: string;
}

export const DIAGRAM_TEMPLATES: readonly DiagramTemplate[] = [
  {
    id: 'mermaid-flowchart',
    kind: 'mermaid',
    label: 'Mermaid: Flowchart',
    detail: 'Top-down decision flowchart',
    content: MERMAID_TEMPLATE,
  },
  {
    id: 'mermaid-sequence',
    kind: 'mermaid',
    label: 'Mermaid: Sequence Diagram',
    detail: 'Actor and service interaction timeline',
    content: `sequenceDiagram
    actor User
    participant App as Web App
    participant API as Backend API

    User->>App: Submit form
    App->>+API: POST /items
    API-->>-App: 201 Created
    App-->>User: Show confirmation
`,
  },
  {
    id: 'mermaid-class',
    kind: 'mermaid',
    label: 'Mermaid: Class Diagram',
    detail: 'Object-oriented classes and relationships',
    content: `classDiagram
    class OrderService {
        +createOrder(items) Order
        +cancelOrder(id) bool
    }
    class OrderRepository {
        +save(order) void
        +findById(id) Order
    }
    OrderService --> OrderRepository : depends on
`,
  },
  {
    id: 'mermaid-state',
    kind: 'mermaid',
    label: 'Mermaid: State Diagram',
    detail: 'Finite state machine transitions',
    content: `stateDiagram-v2
    [*] --> Draft
    Draft --> Review : submit
    Review --> Approved : approve
    Review --> Draft : request changes
    Approved --> [*]
`,
  },
  {
    id: 'mermaid-er',
    kind: 'mermaid',
    label: 'Mermaid: ER Diagram',
    detail: 'Database entities and foreign-key relationships',
    content: `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    CUSTOMER {
        string id PK
        string email
    }
    ORDER {
        string id PK
        datetime created_at
    }
`,
  },
  {
    id: 'mermaid-gantt',
    kind: 'mermaid',
    label: 'Mermaid: Gantt Chart',
    detail: 'Project milestones and task schedule',
    content: `gantt
    title Release Plan
    dateFormat YYYY-MM-DD
    section Design
        Architecture review :a1, 2026-01-01, 4d
    section Implementation
        Core features       :a2, after a1, 8d
        Integration tests   :after a2, 3d
`,
  },
  {
    id: 'mermaid-mindmap',
    kind: 'mermaid',
    label: 'Mermaid: Mindmap',
    detail: 'Hierarchical topic mindmap',
    content: `mindmap
  root((System Design))
    Frontend
      UI Components
      State Management
    Backend
      REST API
      Storage
`,
  },
  {
    id: 'plantuml-sequence',
    kind: 'plantuml',
    label: 'PlantUML: Sequence Diagram',
    detail: 'Participant message sequence',
    content: PLANTUML_TEMPLATE,
  },
  {
    id: 'plantuml-class',
    kind: 'plantuml',
    label: 'PlantUML: Class Diagram',
    detail: 'Interfaces, classes, and associations',
    content: `@startuml
interface Renderer {
  +render(source: String): String
}

class PlantUmlRenderer {
  -cache: Map
  +render(source: String): String
}

PlantUmlRenderer ..|> Renderer
@enduml
`,
  },
  {
    id: 'plantuml-component',
    kind: 'plantuml',
    label: 'PlantUML: Component Diagram',
    detail: 'Packages, services, and databases',
    content: `@startuml
package "Backend" {
  [Gateway] --> [Auth Service]
  [Gateway] --> [Order Service]
}
database "Primary DB" as DB
[Order Service] --> DB
@enduml
`,
  },
  {
    id: 'plantuml-activity',
    kind: 'plantuml',
    label: 'PlantUML: Activity Diagram',
    detail: 'Conditional workflow and branches',
    content: `@startuml
start
:Validate request;
if (Authorized?) then (yes)
  :Execute action;
  :Return 200 OK;
else (no)
  :Return 401 Unauthorized;
endif
stop
@enduml
`,
  },
  {
    id: 'plantuml-mindmap',
    kind: 'plantuml',
    label: 'PlantUML: MindMap',
    detail: 'OrgMode-style PlantUML mindmap',
    content: `@startmindmap
* Architecture
** Client
*** Webview
*** Editor
** Host
*** PreviewManager
*** Renderer
@endmindmap
`,
  },
  {
    id: 'drawio-flowchart',
    kind: 'drawio',
    label: 'Draw.io: Flowchart (.drawio / .drawio.svg / .drawio.png)',
    detail: 'Editable visual canvas diagram',
    content: DRAWIO_TEMPLATE,
  },
  {
    id: 'dot-digraph',
    kind: 'dot',
    label: 'Graphviz DOT: Directed Architecture Graph',
    detail: 'Clustered DAG rendered offline or via Graphviz dot',
    content: DOT_TEMPLATE,
  },
  {
    id: 'wavedrom-timing',
    kind: 'wavedrom',
    label: 'WaveDrom: Digital Timing Waveform',
    detail: 'Clock, chip-select, and data bus timing diagram',
    content: WAVEDROM_TEMPLATE,
  },
  {
    id: 'wavedrom-register',
    kind: 'wavedrom',
    label: 'WaveDrom: Hardware Register BitField',
    detail: '16/32-bit register bit-field layout table',
    content: WAVEDROM_REG_TEMPLATE,
  },
  {
    id: 'd2-architecture',
    kind: 'd2',
    label: 'D2: Modern Architecture Diagram',
    detail: 'Declarative containers, shapes, and directed flows',
    content: D2_TEMPLATE,
  },
];
