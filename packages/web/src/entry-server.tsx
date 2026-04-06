export default function handleServerEntry() {
  return new Response("SSR is not configured for this build.", { status: 501 });
}
