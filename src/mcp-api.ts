/** MCP authorization as an embedding host sees it. No SDK or harness types cross this boundary. */
export type McpErrorCode =
  | "configuration"
  | "authorization_required"
  | "authorization_mismatch"
  | "insufficient_scope"
  | "refresh_uncertain"
  | "canceled"
  | "connection"
  | "protocol"
  | "storage";

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly server?: string;
  constructor(code: McpErrorCode, message: string, server?: string) {
    super(server ? `${server}: ${message}` : message);
    this.name = "McpError";
    this.code = code;
    this.server = server;
  }
}

export interface McpGrantRecord {
  version: 1;
  serverUrl: string;
  resource: string;
  issuer: string;
  client: {
    id: string;
    secret?: string;
    tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  };
  scopes: readonly string[];
  status: "ready" | "refreshing" | "reauthorization_required";
  generation: number;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface McpGrantSummary {
  id: string;
  serverUrl: string;
  resource: string;
  issuer: string;
  scopes: readonly string[];
  status: McpGrantRecord["status"];
  expiresAt?: number;
}

export interface McpGrantAccess {
  read(): McpGrantRecord | undefined;
  write(record: McpGrantRecord): Promise<void>;
  remove(): Promise<void>;
}

export interface McpGrantStore {
  read(grantId: string): Promise<McpGrantRecord | undefined>;
  list(): Promise<readonly McpGrantSummary[]>;
  /** Exclusive across all callers sharing storage. Each write is durable immediately, even if operation later throws. */
  withGrant<T>(grantId: string, operation: (grant: McpGrantAccess) => Promise<T>): Promise<T>;
}

export interface McpAuthorization {
  store: McpGrantStore;
  bindings: Readonly<Record<string, string>>;
}

export interface McpOptions {
  store?: McpGrantStore;
  bindings?: Readonly<Record<string, string>>;
  /** Per-instance interpolation values; never copied into process.env. */
  variables?: Readonly<Record<string, string>>;
  /** The host's outbound network policy, also used for OAuth discovery and refresh. */
  fetch?: typeof globalThis.fetch;
}

export interface McpServerSummary {
  name: string;
  transport: "stdio" | "http";
  url?: string;
  authorization:
    | "not_required"
    | "not_bound"
    | "ready"
    | "refresh_needed"
    | "reauthorization_required"
    | "binding_mismatch";
  grantId?: string;
}

export interface McpSignInInteraction {
  signal?: AbortSignal;
  confirmAuthorization(request: {
    server: string;
    resource: string;
    issuer: string;
    scopes: readonly string[];
  }): Promise<boolean>;
  notify(event: { type: "auth_url"; url: string } | { type: "progress"; message: string }): void;
}

export interface McpSignInRequest {
  agentDir: string;
  server: string;
  store: McpGrantStore;
  interaction: McpSignInInteraction;
  scopes?: readonly string[];
  /** Non-secret registration choices for servers that require a pre-registered public client. */
  clientId?: string;
  callbackPort?: number;
  timeoutSeconds?: number;
  variables?: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
}
