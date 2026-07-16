import type { Approval, ApprovalState, Input as InputItem, InputState, Session } from "@mayi/contracts";
import { MayiClient } from "@mayiapp/sdk";
import { useCallback, useEffect, useState } from "react";
import { ActivityRow } from "~/components/activity-row";
import { ReceiptMark } from "~/components/receipt-mark";
import { StateBadge } from "~/components/state-badge";
import { ThemeToggle } from "~/components/theme-toggle";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { relativeTime } from "~/lib/format";
import { ApprovalDetail } from "~/screens/approval-detail";
import { Auth } from "~/screens/auth";
import { InputDetail } from "~/screens/input-detail";

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

/** The URL is the source of truth for which request is open — an email or push
 *  notification deep-links straight to ?approval=<id> or ?input=<id>. */
type Selection = { kind: "approval" | "input"; id: string };

function linkedSelection(): Selection | undefined {
  const params = new URLSearchParams(location.search);
  const approval = params.get("approval");
  if (approval) return { kind: "approval", id: approval };
  const input = params.get("input");
  if (input) return { kind: "input", id: input };
  return undefined;
}

/** Approvals and questions share the inbox, so rows flatten to what a row shows:
 *  what the agent said, in a person's words — never the action name. */
type InboxRow = {
  kind: "approval" | "input";
  id: string;
  title: string;
  state: ApprovalState | InputState;
  createdAt: string;
  expiresAt: string;
};

export function App() {
  const [session, setSession] = useState<Session | null | undefined>();
  const [items, setItems] = useState<Approval[]>();
  const [inputs, setInputs] = useState<InputItem[]>();
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<Selection | undefined>(linkedSelection);
  // The server caps the lists, so an older deep-linked request may not be in them;
  // `byId` holds the direct fetch for the current selection (item: null on failure).
  const [byId, setById] = useState<{ selection: Selection; item: Approval | InputItem | null }>();
  const [tab, setTab] = useState<Tab>("inbox");
  const [activity, setActivity] = useState<Array<Record<string, unknown>>>([]);
  const [agents, setAgents] = useState<Array<Record<string, unknown>>>([]);
  const [secret, setSecret] = useState("");

  const load = useCallback(async () => {
    try {
      const [approvals, questions] = await Promise.all([api.listApprovals(), api.listInputs()]);
      setItems(approvals);
      setInputs(questions);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  const open = useCallback((next: Selection | undefined) => {
    const url = new URL(location.href);
    url.searchParams.delete("approval");
    url.searchParams.delete("input");
    if (next) url.searchParams.set(next.kind, next.id);
    history.pushState(null, "", url);
    setSelected(next);
  }, []);

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null));
    const onPop = () => setSelected(linkedSelection());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!selected || !items || !inputs) return;
    const list: ReadonlyArray<{ id: string }> = selected.kind === "approval" ? items : inputs;
    if (list.some((item) => item.id === selected.id)) return;
    // Re-runs whenever the lists reload, so onRefresh={load} also refreshes this item.
    let stale = false;
    (selected.kind === "approval" ? api.approval(selected.id) : api.input(selected.id))
      .then((item) => !stale && setById({ selection: selected, item }))
      .catch(() => !stale && setById({ selection: selected, item: null }));
    return () => {
      stale = true;
    };
  }, [selected, items, inputs]);

  useEffect(() => {
    if (!session) return;
    // A signed-in user can land here mid-OAuth (the consent flow parks its return
    // URL in the query string); resume it instead of showing the inbox.
    const returnTo = new URLSearchParams(location.search).get("returnTo");
    if (returnTo?.startsWith("/api/oauth/authorize?")) {
      location.assign(returnTo);
      return;
    }
    void load();
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

  // A deep link lands before the lists have loaded; hold the blank state rather than
  // flashing the inbox under someone who was sent straight to one request.
  if (!items || !inputs) {
    return (
      <div className="grid min-h-screen place-items-center">
        {loadError ? (
          <div className="grid gap-3 text-center text-[14px] text-muted-foreground">
            <p>Your inbox could not be loaded.</p>
            <Button variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : (
          <span className="text-[14px] text-muted-foreground">Loading…</span>
        )}
      </div>
    );
  }

  const fetchedById =
    selected && byId && byId.selection.kind === selected.kind && byId.selection.id === selected.id
      ? byId
      : undefined;

  if (selected?.kind === "approval") {
    const current = items.find((item) => item.id === selected.id) ?? (fetchedById?.item as Approval | null | undefined);
    if (current) {
      return (
        <ApprovalDetail
          item={current}
          email={session.user.email}
          api={api}
          onBack={() => open(undefined)}
          onRefresh={load}
        />
      );
    }
  }

  if (selected?.kind === "input") {
    const current = inputs.find((item) => item.id === selected.id) ?? (fetchedById?.item as InputItem | null | undefined);
    if (current) {
      return <InputDetail item={current} api={api} onBack={() => open(undefined)} onRefresh={load} />;
    }
  }

  // A deep-linked id outside the capped lists: hold the blank state while the by-id
  // fetch is in flight; a failed fetch falls through to the inbox as before.
  if (selected && fetchedById === undefined) {
    return <div className="grid min-h-screen place-items-center text-[14px] text-muted-foreground">Loading…</div>;
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

  const rows: InboxRow[] = [
    ...items
      .filter((item) => (tab === "inbox" ? item.state === "PENDING" : item.state !== "PENDING" && item.state !== "DRAFT"))
      .map(
        (item): InboxRow => ({
          kind: "approval",
          id: item.id,
          title: item.explanation,
          state: item.state,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
        }),
      ),
    ...inputs
      .filter((item) => (tab === "inbox" ? item.state === "PENDING" : item.state !== "PENDING"))
      .map(
        (item): InboxRow => ({
          kind: "input",
          id: item.id,
          title: item.prompt,
          state: item.state,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
        }),
      ),
  ].sort((a, b) =>
    // The inbox is a to-do list, so the soonest deadline floats up; history is a
    // record, so the most recent request leads.
    tab === "inbox" ? a.expiresAt.localeCompare(b.expiresAt) : b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <>
      <header className="border-b border-border">
        <div className="mx-auto flex w-[min(980px,100%-3rem)] items-center justify-between py-4">
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            <ReceiptMark className="h-[19px] w-[19px]" />
            May I?
          </span>
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
          {/* Full width on phones so four tabs share the row evenly; natural width
              once there is room. */}
          <TabsList className="w-full sm:w-fit">
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
                {tab === "inbox" ? "Waiting on you" : "History"}
              </h1>
              <div className="mt-6 grid gap-2">
                {rows.length ? (
                  rows.map((row) => (
                    <Row key={row.id} onClick={() => open({ kind: row.kind, id: row.id })}>
                      <span className="grid min-w-0 gap-1">
                        <span className="truncate text-[14px] font-medium">{row.title}</span>
                        <span className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
                          {row.kind === "approval" ? "Approval" : "Question"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <span className="hidden text-[12px] text-muted-foreground sm:block">
                          {row.state === "PENDING" ? relativeTime(row.expiresAt) : null}
                        </span>
                        <StateBadge state={row.state} />
                      </span>
                    </Row>
                  ))
                ) : (
                  <Empty>{tab === "inbox" ? "Nothing is waiting on you." : "Nothing resolved yet."}</Empty>
                )}
              </div>
            </>
          )}

          {tab === "agents" && (
            <>
              <h1 className="text-[24px] font-semibold tracking-[-0.01em]">Connected agents</h1>
              <form onSubmit={createAgent} className="mt-6 flex flex-col gap-2 sm:flex-row">
                <Input name="name" placeholder="Agent name" required className="sm:flex-1" />
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
                  activity.map((entry) => <ActivityRow key={String(entry.id)} entry={entry} />)
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
