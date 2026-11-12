import { agentApiConformance } from "./agent-api-conformance.ts";
import { durableSubject } from "./durable-subject.ts";

agentApiConformance("pi-durable, in process", durableSubject());
