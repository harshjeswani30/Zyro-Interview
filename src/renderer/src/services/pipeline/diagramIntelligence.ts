// diagramIntelligence.ts - Natively-style System Design & Mermaid Diagram Generator

export function getSystemDesignDiagramPrompt(isSystemDesign: boolean): string {
  if (!isSystemDesign) return ''

  return `
=== SYSTEM DESIGN DIAGRAM INSTRUCTION (MANDATORY) ===
Because this is a System Design / Architecture question, you MUST include a clean Mermaid.js flowchart diagram illustrating the high-level system architecture.
Use the following format right before or after your explanation:

\`\`\`mermaid
flowchart TD
    Client[Client / App] --> API[API Gateway]
    API --> Auth[Auth Service]
    API --> LB[Load Balancer]
    LB --> ServiceA[Microservice A]
    LB --> ServiceB[Microservice B]
    ServiceA --> Cache[(Redis Cache)]
    ServiceA --> DB[(Primary Database)]
\`\`\`
Keep the Mermaid diagram clear, properly indented, with valid syntax, nodes, and directional arrows (-->).
=== END DIAGRAM INSTRUCTION ===
`
}
