import { render, Text } from "@react-email/components";
import { EmailLayout } from "./email-layout";
import { styles } from "./shared-styles";

export interface ForwardingVerificationEmailProps {
  code: string;
  workspaceName: string;
}

export default function ForwardingVerification({ code, workspaceName }: ForwardingVerificationEmailProps) {
  return (
    <EmailLayout preview={`Your May I? verification code is ${code}`}>
      <Text style={styles.kicker}>Verify this address</Text>
      <Text style={styles.prose}>
        The workspace <strong>{workspaceName}</strong> wants to forward approval requests to
        this address. Enter this code to confirm:
      </Text>
      <Text style={{ ...styles.actionName, fontSize: "28px", letterSpacing: "0.08em", margin: "16px 0" }}>
        {code}
      </Text>
      <Text style={styles.footerText}>
        The code expires in 15 minutes. If you did not expect this, ignore it — nothing is
        forwarded until the code is entered.
      </Text>
    </EmailLayout>
  );
}

export function renderForwardingVerificationEmail(props: ForwardingVerificationEmailProps): Promise<string> {
  return render(<ForwardingVerification {...props} />);
}
