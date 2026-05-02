import { describe, expect, it } from "vitest";
import { normalizeRemoteUrl, ownerRepoFromNormalized } from "../src/fsa/normalize.ts";

describe("normalizeRemoteUrl", () => {
  it("handles HTTPS remotes with .git suffix", () => {
    expect(normalizeRemoteUrl("https://github.com/foo/bar.git")).toBe("github.com/foo/bar");
  });

  it("handles HTTPS remotes without .git suffix", () => {
    expect(normalizeRemoteUrl("https://github.com/foo/bar")).toBe("github.com/foo/bar");
  });

  it("strips trailing slash", () => {
    expect(normalizeRemoteUrl("https://github.com/foo/bar.git/")).toBe("github.com/foo/bar");
  });

  it("handles SCP-style SSH remotes", () => {
    expect(normalizeRemoteUrl("git@github.com:foo/bar.git")).toBe("github.com/foo/bar");
  });

  it("handles SSH remotes with explicit scheme", () => {
    expect(normalizeRemoteUrl("ssh://git@github.com/foo/bar.git")).toBe("github.com/foo/bar");
  });

  it("handles git:// scheme", () => {
    expect(normalizeRemoteUrl("git://github.com/foo/bar")).toBe("github.com/foo/bar");
  });

  it("strips embedded credentials", () => {
    expect(normalizeRemoteUrl("https://user:pw@github.com/foo/bar.git")).toBe("github.com/foo/bar");
  });

  it("lowercases input", () => {
    expect(normalizeRemoteUrl("https://GitHub.COM/Foo/Bar.git")).toBe("github.com/foo/bar");
  });

  it("returns null for empty input", () => {
    expect(normalizeRemoteUrl("")).toBeNull();
    expect(normalizeRemoteUrl(null)).toBeNull();
    expect(normalizeRemoteUrl(undefined)).toBeNull();
  });

  it("returns null for non-URL bare paths", () => {
    expect(normalizeRemoteUrl("/repos/foo/bar.git")).toBeNull();
  });

  it("works with non-github hosts", () => {
    expect(normalizeRemoteUrl("https://gitlab.example.com/team/project.git")).toBe(
      "gitlab.example.com/team/project",
    );
  });
});

describe("ownerRepoFromNormalized", () => {
  it("extracts owner/repo from a host/owner/repo triple", () => {
    expect(ownerRepoFromNormalized("github.com/foo/bar")).toBe("foo/bar");
  });

  it("lowercases output", () => {
    expect(ownerRepoFromNormalized("github.com/Foo/Bar")).toBe("foo/bar");
  });

  it("returns null for null input", () => {
    expect(ownerRepoFromNormalized(null)).toBeNull();
  });

  it("returns null for inputs without three segments", () => {
    expect(ownerRepoFromNormalized("github.com/foo")).toBeNull();
    expect(ownerRepoFromNormalized("foo")).toBeNull();
  });

  it("handles deeper paths by taking the last two segments", () => {
    expect(ownerRepoFromNormalized("git.example.com/team/sub/project")).toBe("sub/project");
  });
});
