package daemon

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

type ValidationError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

func LoadEnv(envName, configDir string, cliOverrides map[string]string) (map[string]string, error) {
	result := map[string]string{}
	files := []string{
		filepath.Join(configDir, ".env"),
		filepath.Join(configDir, ".env.local"),
		filepath.Join(configDir, fmt.Sprintf(".env.%s", envName)),
	}

	for _, envFile := range files {
		content, err := os.ReadFile(envFile)
		if err != nil {
			continue
		}
		parsed, err := godotenv.Unmarshal(string(content))
		if err != nil {
			return nil, err
		}
		for key, value := range parsed {
			result[key] = substituteVars(value, result, nil)
		}
	}

	for key, value := range cliOverrides {
		result[key] = value
	}

	for _, env := range os.Environ() {
		if idx := strings.Index(env, "="); idx > 0 {
			key := env[:idx]
			if _, exists := result[key]; !exists {
				result[key] = env[idx+1:]
			}
		}
	}

	return result, nil
}

func ParseConfig(content []byte, envVars map[string]string) (SpawntreeConfig, error) {
	var raw any
	if err := yaml.Unmarshal(content, &raw); err != nil {
		return SpawntreeConfig{}, err
	}
	substituted := substituteInAny(raw, envVars)
	out, err := yaml.Marshal(substituted)
	if err != nil {
		return SpawntreeConfig{}, err
	}

	var cfg SpawntreeConfig
	if err := yaml.Unmarshal(out, &cfg); err != nil {
		return SpawntreeConfig{}, err
	}
	cfg.ServiceOrder = extractServiceOrder(out)
	if len(cfg.ServiceOrder) == 0 {
		for name := range cfg.Services {
			cfg.ServiceOrder = append(cfg.ServiceOrder, name)
		}
		sort.Strings(cfg.ServiceOrder)
	}
	return cfg, nil
}

func ValidateConfig(cfg SpawntreeConfig) []ValidationError {
	var errors []ValidationError
	if len(cfg.Services) == 0 {
		return []ValidationError{{Path: "services", Message: "At least one service is required"}}
	}

	validTypes := map[ServiceType]bool{
		ServiceTypeProcess:   true,
		ServiceTypeContainer: true,
		ServiceTypePostgres:  true,
		ServiceTypeRedis:     true,
		ServiceTypeExternal:  true,
	}

	for name, svc := range cfg.Services {
		if !validTypes[svc.Type] {
			errors = append(errors, ValidationError{
				Path:    fmt.Sprintf("services.%s.type", name),
				Message: fmt.Sprintf("Unknown type %q. Valid types: process, container, postgres, redis, external", svc.Type),
			})
		}
		if svc.Type == ServiceTypeProcess && svc.Command == "" {
			errors = append(errors, ValidationError{
				Path:    fmt.Sprintf("services.%s.command", name),
				Message: "command is required for process services",
			})
		}
		if svc.Type == ServiceTypeContainer && svc.Image == "" {
			errors = append(errors, ValidationError{
				Path:    fmt.Sprintf("services.%s.image", name),
				Message: "image is required for container services",
			})
		}
		if svc.Type == ServiceTypeExternal && svc.URL == "" {
			errors = append(errors, ValidationError{
				Path:    fmt.Sprintf("services.%s.url", name),
				Message: "url is required for external services",
			})
		}
		for _, dep := range svc.DependsOn {
			if _, ok := cfg.Services[dep]; !ok {
				errors = append(errors, ValidationError{
					Path:    fmt.Sprintf("services.%s.depends_on", name),
					Message: fmt.Sprintf("Unknown dependency %q", dep),
				})
			}
		}
		for idx, vol := range svc.Volumes {
			if vol.Host == "" {
				errors = append(errors, ValidationError{
					Path:    fmt.Sprintf("services.%s.volumes[%d].host", name, idx),
					Message: "host is required",
				})
			}
			if vol.Container == "" {
				errors = append(errors, ValidationError{
					Path:    fmt.Sprintf("services.%s.volumes[%d].container", name, idx),
					Message: "container is required",
				})
			}
			if vol.Mode != "" && vol.Mode != "ro" && vol.Mode != "rw" {
				errors = append(errors, ValidationError{
					Path:    fmt.Sprintf("services.%s.volumes[%d].mode", name, idx),
					Message: `mode must be "ro" or "rw"`,
				})
			}
		}
	}

	if cycle := detectCycles(cfg.Services); cycle != "" {
		errors = append(errors, ValidationError{Path: "services", Message: cycle})
	}

	return errors
}

func detectCycles(services map[string]ServiceConfig) string {
	visited := map[string]bool{}
	stack := map[string]bool{}
	var path []string

	var dfs func(string) string
	dfs = func(name string) string {
		if stack[name] {
			cycleStart := 0
			for i, item := range path {
				if item == name {
					cycleStart = i
					break
				}
			}
			return fmt.Sprintf("Circular dependency detected: %s", strings.Join(append(path[cycleStart:], name), " -> "))
		}
		if visited[name] {
			return ""
		}
		visited[name] = true
		stack[name] = true
		path = append(path, name)
		for _, dep := range services[name].DependsOn {
			if result := dfs(dep); result != "" {
				return result
			}
		}
		path = path[:len(path)-1]
		delete(stack, name)
		return ""
	}

	names := make([]string, 0, len(services))
	for name := range services {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if result := dfs(name); result != "" {
			return result
		}
	}
	return ""
}

func substituteVars(template string, vars map[string]string, missing map[string]bool) string {
	re := regexp.MustCompile(`\$\{([^}]+)\}`)
	return re.ReplaceAllStringFunc(template, func(match string) string {
		submatches := re.FindStringSubmatch(match)
		if len(submatches) < 2 {
			return match
		}
		key := submatches[1]
		if value, ok := vars[key]; ok {
			return value
		}
		if missing != nil {
			missing[key] = true
		}
		return match
	})
}

func substituteInAny(value any, vars map[string]string) any {
	switch typed := value.(type) {
	case string:
		return substituteVars(typed, vars, nil)
	case map[string]any:
		out := map[string]any{}
		for key, item := range typed {
			out[key] = substituteInAny(item, vars)
		}
		return out
	case map[any]any:
		out := map[string]any{}
		for key, item := range typed {
			out[fmt.Sprint(key)] = substituteInAny(item, vars)
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, substituteInAny(item, vars))
		}
		return out
	default:
		return value
	}
}

func ResolveServiceConfig(service ServiceConfig, envVars map[string]string) ServiceConfig {
	resolved := service
	if resolved.Command != "" {
		resolved.Command = substituteVars(resolved.Command, envVars, nil)
	}
	if resolved.URL != "" {
		resolved.URL = substituteVars(resolved.URL, envVars, nil)
	}
	if resolved.ForkFrom != "" {
		resolved.ForkFrom = substituteVars(resolved.ForkFrom, envVars, nil)
	}
	if resolved.Healthcheck != nil && resolved.Healthcheck.URL != "" {
		healthcheck := *resolved.Healthcheck
		healthcheck.URL = substituteVars(healthcheck.URL, envVars, nil)
		resolved.Healthcheck = &healthcheck
	}
	if len(resolved.Environment) > 0 {
		env := map[string]string{}
		for key, value := range resolved.Environment {
			env[key] = substituteVars(value, envVars, nil)
		}
		resolved.Environment = env
	}
	return resolved
}

func MustYAML(v any) []byte {
	out, err := yaml.Marshal(v)
	if err != nil {
		panic(err)
	}
	return bytes.TrimSpace(out)
}

func extractServiceOrder(content []byte) []string {
	var node yaml.Node
	if err := yaml.Unmarshal(content, &node); err != nil || len(node.Content) == 0 {
		return nil
	}
	root := node.Content[0]
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value != "services" {
			continue
		}
		servicesNode := root.Content[i+1]
		order := []string{}
		for j := 0; j+1 < len(servicesNode.Content); j += 2 {
			order = append(order, servicesNode.Content[j].Value)
		}
		return order
	}
	return nil
}
