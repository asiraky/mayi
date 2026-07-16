import { Button, render, Text } from "@react-email/components";
import { EmailLayout } from "./email-layout";
import { styles } from "./shared-styles";

/*
 * The one email that matters: an agent is waiting on a human. It leads with the
 * agent's explanation as prose — the reason a person can actually judge — with the
 * action named in plain language and a single deep link that lands directly on the
 * approval so the decision is two taps away. Nothing sensitive travels in the mail
 * itself — the exact payload, artefacts and receipt live behind the authenticated link.
 */

export interface ApprovalRequestedEmailProps {
  actionKind: string;
  explanation: string;
  agentName: string;
  workspaceName: string;
  highRisk: boolean;
  expiresAtIso: string;
  expiresInText: string;
  reviewUrl: string;
  approvalId: string;
}

export default function ApprovalRequested({
  actionKind,
  explanation,
  agentName,
  workspaceName,
  highRisk,
  expiresInText,
  reviewUrl,
}: ApprovalRequestedEmailProps) {
  return (
    <EmailLayout preview={`${agentName} asks: may I ${actionKind}? Expires ${expiresInText}.`}>
      <Text style={styles.kicker}>Approval requested</Text>
      <Text style={styles.hero}>{explanation}</Text>
      <Text style={styles.metaLine}>
        {agentName} is asking to {actionKind} in {workspaceName} · expires {expiresInText}
      </Text>

      {highRisk && (
        <table style={styles.highRisk} width="100%">
          <tbody>
            <tr>
              <td>
                <Text style={styles.highRiskText}>
                  This is a high-risk request — deciding it will ask you to sign in again.
                </Text>
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <Button href={reviewUrl} style={styles.button}>
        Review this request
      </Button>

      <Text style={styles.footerText}>
        The exact payload, evidence and signed receipt are shown after you sign in. If the
        button does not work, open this link:
      </Text>
      <Text style={styles.footerLink}>{reviewUrl}</Text>
      <Text style={styles.footerText}>
        You are receiving this because your workspace forwards approval requests to this
        address. If you did not expect it, deny the request and review your forwarding rules.
      </Text>
    </EmailLayout>
  );
}

export function renderApprovalRequestedEmail(props: ApprovalRequestedEmailProps): Promise<string> {
  return render(<ApprovalRequested {...props} />);
}
