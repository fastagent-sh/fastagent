import { join } from 'node:path';
import { AgentCoreApplication, type AgentCoreApplicationProps } from '@aws/agentcore-cdk';
import { FastAgentResources } from '@fastagent-sh/agentcore/cdk';
import { Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface AgentCoreStackProps extends StackProps {
  /** Props for the AgentCore application, produced by transformAgentCoreJson from agentcore/agentcore.json. */
  application: AgentCoreApplicationProps;
}

/**
 * The stack the AgentCore CLI deploys (`agentcore deploy`). Everything declared in agentcore/agentcore.json is created
 * by the AgentCoreApplication construct; FastAgentResources adds what the agent needs beside its runtime. Add your own
 * resources below them.
 */
export class AgentCoreStack extends Stack {
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);
    this.application = new AgentCoreApplication(this, 'Application', props.application);

    // The Aurora DSQL cluster the agent's instances are in, the EventBridge Scheduler group its alarms run on, and read
    // access to the Secrets Manager secret its values are in (create it yourself, in each account you deploy to: a JSON
    // object of names to values). For a schedule-only or single-instance agent that runs before any caller connects, pass
    // `instances: ['<session-id-at-least-33-chars>']`.
    new FastAgentResources(this, 'FastAgent', {
      runtime: this.application.runtime('agent'),
      agentDir: join(__dirname, '../../../..'),
      secretName: '{{secret}}',
    });
  }
}
