import { ImageIcon } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/utils";

/*
 * The review document is written by an integration, so it is untrusted input rendered
 * for a person. The safety posture is react-markdown's defaults plus two choices:
 *   - no raw HTML: rehype-raw is deliberately absent, so embedded HTML is shown as text
 *     or dropped, never parsed;
 *   - no remote images: an <img> would load on open and could be a tracking pixel, so
 *     images render as a plain link the reviewer can choose to follow.
 * URLs still pass through react-markdown's default transform, which drops javascript:
 * and other non-web protocols.
 *
 * Headings shift down one level: the page's h1 is the request title, so a document's
 * own "# Proposal" is a section of it, not a rival.
 */
/** react-markdown hands each component its syntax-tree node; keep it off the DOM. */
function withoutNode<P extends { node?: unknown }>(props: P): Omit<P, "node"> {
  const { node, ...rest } = props;
  void node;
  return rest;
}

const heading = "font-semibold tracking-[-0.01em] text-foreground scroll-mt-6";

const components: Components = {
  h1: (props) => <h2 className={cn(heading, "mt-10 mb-3 text-[20px] leading-[1.35]")} {...withoutNode(props)} />,
  h2: (props) => <h3 className={cn(heading, "mt-9 mb-3 text-[17px] leading-[1.4]")} {...withoutNode(props)} />,
  h3: (props) => <h4 className={cn(heading, "mt-7 mb-2 text-[15px] leading-[1.45]")} {...withoutNode(props)} />,
  h4: (props) => <h5 className={cn(heading, "mt-6 mb-2 text-[14px]")} {...withoutNode(props)} />,
  h5: (props) => <h6 className={cn(heading, "mt-6 mb-2 text-[13px] text-muted-foreground")} {...withoutNode(props)} />,
  h6: (props) => <h6 className={cn(heading, "mt-6 mb-2 text-[13px] text-muted-foreground")} {...withoutNode(props)} />,
  p: (props) => <p className="my-4" {...withoutNode(props)} />,
  // In-document anchors (GFM footnotes) stay in the tab; everything else opens a new one.
  // The URL transform empties unsafe hrefs (javascript: and friends); show those as text.
  a: (props) =>
    props.href ? (
      <a
        {...withoutNode(props)}
        {...(props.href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer nofollow" })}
        className="font-medium break-words text-primary-ink underline decoration-primary-ink/35 underline-offset-[3px] transition-colors hover:decoration-primary-ink"
      />
    ) : (
      <span>{props.children}</span>
    ),
  img: ({ src, alt }) => {
    const label = alt || (typeof src === "string" ? src : "Image");
    return typeof src === "string" && src ? (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="inline-flex items-baseline gap-1 break-all text-primary-ink underline decoration-primary-ink/35 underline-offset-[3px] hover:decoration-primary-ink"
      >
        <ImageIcon className="size-3.5 shrink-0 self-center" aria-hidden="true" />
        {label}
      </a>
    ) : (
      <span>{label}</span>
    );
  },
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "my-4 list-disc pl-6 marker:text-muted-foreground",
        // GFM task lists: the checkbox is the marker.
        className?.includes("contains-task-list") && "list-none pl-1",
        className,
      )}
      {...withoutNode(props)}
    />
  ),
  ol: (props) => <ol className="my-4 list-decimal pl-6 marker:text-muted-foreground" {...withoutNode(props)} />,
  li: ({ className, ...props }) => (
    <li
      className={cn(
        "my-1.5 pl-1 [&>ol]:my-1.5 [&>p]:my-2 [&>ul]:my-1.5",
        className?.includes("task-list-item") && "[&>input]:mr-2 [&>input]:translate-y-px [&>input]:accent-primary",
        className,
      )}
      {...withoutNode(props)}
    />
  ),
  blockquote: (props) => (
    <blockquote className="my-5 border-l-2 border-primary/40 pl-4 text-muted-foreground [&>p]:my-2" {...withoutNode(props)} />
  ),
  hr: () => <hr className="my-8 border-border" />,
  table: (props) => (
    // Wide tables scroll inside their own box rather than widening the page on a phone.
    <div className="my-5 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-left text-[14px] leading-[1.5]" {...withoutNode(props)} />
    </div>
  ),
  thead: (props) => <thead className="bg-muted/60" {...withoutNode(props)} />,
  th: (props) => (
    <th className="border-b border-border px-3 py-2 align-bottom font-semibold whitespace-nowrap text-foreground" {...withoutNode(props)} />
  ),
  td: (props) => (
    <td className="border-b border-border px-3 py-2 align-top [tr:last-child>&]:border-b-0" {...withoutNode(props)} />
  ),
  // Inline code. Fenced blocks reuse this element inside <pre>, which resets it below.
  code: ({ className, ...props }) => (
    <code
      className={cn("rounded-[5px] bg-muted px-1.5 py-0.5 font-mono text-[0.86em] break-words text-foreground", className)}
      {...withoutNode(props)}
    />
  ),
  pre: (props) => (
    <pre
      className="my-5 overflow-x-auto rounded-lg border border-border bg-muted p-4 font-mono text-[12.5px] leading-[1.7] text-foreground [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[1em] [&>code]:break-normal"
      {...withoutNode(props)}
    />
  ),
  strong: (props) => <strong className="font-semibold text-foreground" {...withoutNode(props)} />,
  del: (props) => <del className="text-muted-foreground" {...withoutNode(props)} />,
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("max-w-[68ch] text-[15px] leading-[1.7] break-words text-body [&>*:first-child]:mt-0", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
