import { Button, render, Text } from "@react-email/components";
import { EmailLayout } from "./email-layout";
import { styles } from "./shared-styles";

export interface PasswordResetEmailProps {
  resetUrl: string;
}

export default function PasswordReset({ resetUrl }: PasswordResetEmailProps) {
  return (
    <EmailLayout preview="Reset your May I? password">
      <Text style={styles.kicker}>Password reset</Text>
      <Text style={styles.prose}>
        Someone asked to reset the password for the May I? account at this address. If that
        was you, set a new password here:
      </Text>

      <Button href={resetUrl} style={styles.button}>
        Reset password
      </Button>

      <Text style={styles.footerText}>If the button does not work, open this link:</Text>
      <Text style={styles.footerLink}>{resetUrl}</Text>
      <Text style={styles.footerText}>
        The link expires in 30 minutes and works once. If you did not request this, you can
        ignore this email — your password is unchanged.
      </Text>
    </EmailLayout>
  );
}

export function renderPasswordResetEmail(props: PasswordResetEmailProps): Promise<string> {
  return render(<PasswordReset {...props} />);
}
