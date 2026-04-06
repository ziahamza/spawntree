export type Status = "running" | "stopped" | "crashed" | "starting" | "offline";

interface StatusDotProps {
  status: Status;
  className?: string;
}

export function StatusDot({ status, className = "" }: StatusDotProps) {
  // Stopped and offline both render as gray hollow dot per DESIGN.md
  if (status === "offline" || status === "stopped") {
    return (
      <span
        className={`inline-block w-2 h-2 rounded-full border border-muted opacity-50 ${className}`}
        aria-label={status}
      />
    );
  }

  const colorClass = status === "running"
    ? "bg-green"
    : status === "starting"
    ? "bg-orange animate-pulse"
    : "bg-red"; // crashed

  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colorClass} ${className}`}
      aria-label={status}
    />
  );
}
