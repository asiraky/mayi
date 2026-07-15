import { actionName, type Approval, type Session } from "@mayi/contracts";
import { MayiClient } from "@mayi/sdk";
import { useCallback, useEffect, useState } from "react";
import { StateBadge } from "~/components/state-badge";
import { ThemeToggle } from "~/components/theme-toggle";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { relativeTime } from "~/lib/format";
import { ApprovalDetail } from "~/screens/approval-detail";
import { Auth } from "~/screens/auth";

const api = new MayiClient({
  origin: location.origin,
  // The SDK still rejects every non-loopback HTTP host. Key this opt-in to the
  // real origin so the documented production-like local server works too.
  dangerouslyAllowInsecureHttpForDevelopment: location.protocol === "http:",
});

const TABS = ["inbox", "history", "agents", "activity"] as const;
type Tab = (typeof TABS)[number];

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-14 text-center text-[14px] text-muted-foreground">
      {children}
    </div>
  );
}

function Row({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  const className =
    "flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 text-left transition-colors";
  return onClick ? (
    <button onClick={onClick} className={`${className} hover:border-foreground/25`}>
      {children}
    </button>
  ) : (
    <div className={className}>{children}</div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>();
  const [items, setItems] = useState<Approval[]>([]);
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<Tab>("inbox");
  const [activity, setActivity] = useState<Array<Record<string, unknown>>>([]);
  const [agents, setAgents] = useState<Array<Record<string, unknown>>>([]);
  const [secret, setSecret] = useState("");

  const load = useCallback(async () => {
    const values = await api.listApprovals();
    setItems(values);

    // A notification deep-links to ?approval=<id>; open it if it is really ours.
    const linked = new URLSearchParams(location.search).get("approval");
    setSelected((current) => {
      if (linked && values.some((x) => x.id === linked)) return linked;
      return current && values.some((x) => x.id === current) ? current : undefined;
    });
  }, []);

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null));
  }, []);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  if (session === undefined) {
    return <div className="grid min-h-screen place-items-center text-[14px] text-muted-foreground">Loading…</div>;
  }

  if (!session) {
    return (
      <Auth
        api={api}
        onDone={(value) => {
          setSession(value);
          // The OAuth consent flow parks its return URL here; resume it once signed in.
          const returnTo = new URLSearchParams(location.search).get("returnTo");
          if (returnTo?.startsWith("/api/oauth/authorize?")) location.assign(returnTo);
        }}
      />
    );
  }

  const current = items.find((item) => item.id === selected);
  if (current) {
    return (
      <ApprovalDetail
        item={current}
        email={session.user.email}
        api={api}
        onBack={() => setSelected(undefined)}
        onRefresh={load}
      />
    );
  }

  async function openTab(next: Tab) {
    setTab(next);
    if (next === "activity") setActivity(await api.activity());
    if (next === "agents") setAgents(await api.agents());
  }

  async function createAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name"));
    const result = await api.createAgent({ name, scopes: ["approval:create", "approval:read", "approval:cancel"] });
    setSecret(result.token);
    setAgents(await api.agents());
    form.reset();
  }

  const listed = items.filter((item) =>
    tab === "inbox" ? item.state === "PENDING" : item.state !== "PENDING" && item.state !== "DRAFT",
  );

  return (
    <>
      <header className="border-b border-border">
        <div className="mx-auto flex w-[min(980px,100%-3rem)] items-center justify-between py-4">
          <span className="text-[15px] font-semibold">May I?</span>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={async () => {
                await api.signout();
                setSession(null);
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-[min(980px,100%-3rem)] py-10">
        <p className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">
          {session.workspace.name}
        </p>

        <Tabs value={tab} onValueChange={(value) => void openTab(value as Tab)} className="mt-5">
          <TabsList>
            {TABS.map((name) => (
              <TabsTrigger key={name} value={name} className="capitalize">
                {name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="mt-8">
          {(tab === "inbox" || tab === "history") && (
            <>
              <h1 className="text-[24px] font-semibold tracking-[-0.01em]">
                {tab === "inbox" ? "Pending approvals" : "History"}
              </h1>
              <div className="mt-6 grid gap-2">
                {listed.length ? (
                  listed.map((item) => (
                    <Row key={item.id} onClick={() => setSelected(item.id)}>
                      <span className="grid min-w-0 gap-1">
                        {/* The action is machine data; the agent's explanation is not. */}
                        <span className="truncate font-mono text-[14px] font-medium">{actionName(item.action)}</span>
                        <span className="truncate text-[13px] text-muted-foreground">{item.explanation}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <span className="hidden text-[12px] text-muted-foreground sm:block">
                          {item.state === "PENDING" ? relativeTime(item.expiresAt) : null}
                        </span>
                        <StateBadge state={item.state} />
                      </span>
                    </Row>
                  ))
                ) : (
                  <Empty>{tab === "inbox" ? "Nothing is waiting on you." : "No decisions yet."}</Empty>
                )}
              </div>
            </>
          )}

          {tab === "agents" && (
            <>
              <h1 className="text-[24px] font-semibold tracking-[-0.01em]">Connected agents</h1>
              <form onSubmit={createAgent} className="mt-6 flex gap-2">
                <Input name="name" placeholder="Agent name" required className="flex-1" />
                <Button type="submit">New headless agent</Button>
              </form>

              {secret && (
                <div className="mt-4 rounded-xl border border-primary/25 bg-primary/8 p-4">
                  <p className="text-[14px] font-medium text-primary-ink">Copy this token now — it is not shown again.</p>
                  <code className="mt-2 block font-mono text-[12px] break-all text-foreground">{secret}</code>
                </div>
              )}

              <div className="mt-6 grid gap-2">
                {agents.length ? (
                  agents.map((agent) => (
                    <Row key={String(agent.id)}>
                      <span className="grid min-w-0 gap-1">
                        <span className="truncate text-[14px] font-medium">{String(agent.name)}</span>
                        <span className="truncate font-mono text-[12px] text-muted-foreground">
                          {(agent.scopes as string[]).join(" · ")}
                        </span>
                      </span>
                    </Row>
                  ))
                ) : (
                  <Empty>No agents connected yet.</Empty>
                )}
              </div>
            </>
          )}

          {tab === "activity" && (
            <>
              <h1 className="text-[24px] font-semibold tracking-[-0.01em]">Security activity</h1>
              <div className="mt-6 grid gap-2">
                {activity.length ? (
                  activity.map((entry) => (
                    <Row key={String(entry.id)}>
                      <span className="grid min-w-0 gap-1">
                        <span className="truncate font-mono text-[13px]">{String(entry.eventType)}</span>
                        <span className="truncate text-[12px] text-muted-foreground">
                          {relativeTime(String(entry.createdAt))}
                        </span>
                      </span>
                    </Row>
                  ))
                ) : (
                  <Empty>Nothing recorded yet.</Empty>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
