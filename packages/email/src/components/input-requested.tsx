import { Button, render, Text } from "@react-email/components";
import { EmailLayout } from "./email-layout";
import { styles } from "./shared-styles";

/*
 * An agent has stopped to ask a human something. The question itself is the whole
 * email: the prompt reads as prose, a light line says who is asking and for how
 * long, and one button lands directly on the answering screen. No identifiers or
 * machine data travel in the mail — the options and answer live behind the
 * authenticated link.
 */

export interface InputRequestedEmailProps {
  prompt: string;
  agentName: string;
  workspaceName: string;
  expiresInText: string;
  reviewUrl: string;
}

export default function InputRequested({
  prompt,
  agentName,
  workspaceName,
  expiresInText,
  reviewUrl,
}: InputRequestedEmailProps) {
  return (
    <EmailLayout preview={`${agentName} needs your input. Expires ${expiresInText}.`}>
      <Text style={styles.kicker}>An agent needs your input</Text>
      <Text style={styles.hero}>{prompt}</Text>
      <Text style={styles.metaLine}>
        Asked by {agentName} in {workspaceName} · expires {expiresInText}
      </Text>

      <Button href={reviewUrl} style={styles.button}>
        Answer this request
      </Button>

      <Text style={styles.footerText}>
        The agent is paused until you answer or the request expires. If the button does
        not work, open this link:
      </Text>
      <Text style={styles.footerLink}>{reviewUrl}</Text>
      <Text style={styles.footerText}>
        You are receiving this because your workspace forwards agent requests to this
        address. If you did not expect it, review your forwarding destinations.
      </Text>
    </EmailLayout>
  );
}

export function renderInputRequestedEmail(props: InputRequestedEmailProps): Promise<string> {
  return render(<InputRequested {...props} />);
}
