/**
 * Substitute ${VAR_NAME} references in a string with values from the vars map.
 * Returns the string with all substitutions applied.
 * Collects missing variable names for error reporting.
 */
export function substituteVars(
  template: string,
  vars: Record<string, string>,
  missing?: Set<string>,
): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const value = vars[varName];
    if (value === undefined) {
      if (missing) {
        missing.add(varName);
      }
      return `\${${varName}}`;
    }
    return value;
  });
}

/**
 * Find all ${VAR_NAME} references in a string.
 */
export function findVarRefs(template: string): string[] {
  const refs: string[] = [];
  const regex = /\$\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(template)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}
