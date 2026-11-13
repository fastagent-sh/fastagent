import { agentApiConformance } from "../../harnesses/agent-api-conformance.ts";
import { durableSubject } from "../../harnesses/durable-subject.ts";

agentApiConformance("pi-durable, in process", durableSubject());
