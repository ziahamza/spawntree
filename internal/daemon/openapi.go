package daemon

func OpenAPISpec() map[string]any {
	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":   "spawntree daemon API",
			"version": "0.2.0",
		},
		"paths": map[string]any{
			"/api/v1/daemon": map[string]any{
				"get": operation("getDaemonInfo", "DaemonInfo", nil),
			},
			"/api/v1/envs": map[string]any{
				"get":  operation("listEnvs", "ListEnvsResponse", nil),
				"post": operation("createEnv", "CreateEnvResponse", requestBody("CreateEnvRequest")),
			},
			"/api/v1/repos/{repoId}/envs": map[string]any{
				"get": operation("listRepoEnvs", "ListEnvsResponse", nil, pathParam("repoId")),
			},
			"/api/v1/repos/{repoId}/envs/{envId}": map[string]any{
				"get":    operation("getEnv", "GetEnvResponse", nil, pathParam("repoId"), pathParam("envId")),
				"delete": operation("deleteEnv", "DeleteEnvResponse", nil, pathParam("repoId"), pathParam("envId")),
			},
			"/api/v1/repos/{repoId}/envs/{envId}/down": map[string]any{
				"post": operation("downEnv", "DownEnvResponse", nil, pathParam("repoId"), pathParam("envId")),
			},
			"/api/v1/repos/{repoId}/envs/{envId}/logs": map[string]any{
				"get": map[string]any{
					"operationId": "streamLogs",
					"parameters": []any{
						pathParam("repoId"),
						pathParam("envId"),
						map[string]any{"name": "service", "in": "query", "schema": map[string]any{"type": "string"}},
						map[string]any{"name": "follow", "in": "query", "schema": map[string]any{"type": "boolean"}},
						map[string]any{"name": "lines", "in": "query", "schema": map[string]any{"type": "integer"}},
					},
					"responses": map[string]any{
						"200": map[string]any{
							"description": "SSE log stream",
							"content": map[string]any{
								"text/event-stream": map[string]any{
									"schema": ref("LogLine"),
								},
							},
						},
					},
				},
			},
			"/api/v1/infra": map[string]any{
				"get": operation("getInfraStatus", "InfraStatusResponse", nil),
			},
			"/api/v1/infra/stop": map[string]any{
				"post": operation("stopInfra", "StopInfraResponse", requestBody("StopInfraRequest")),
			},
			"/api/v1/db/templates": map[string]any{
				"get": operation("listDbTemplates", "ListDBTemplatesResponse", nil),
			},
			"/api/v1/db/dump": map[string]any{
				"post": operation("dumpDb", "DumpDBResponse", requestBody("DumpDBRequest")),
			},
			"/api/v1/db/restore": map[string]any{
				"post": operation("restoreDb", "RestoreDBResponse", requestBody("RestoreDBRequest")),
			},
			"/api/v1/registry/repos": map[string]any{
				"get":  operation("listRegisteredRepos", "ListRegisteredReposResponse", nil),
				"post": operation("registerRepo", "RegisterRepoResponse", requestBody("RegisterRepoRequest")),
			},
			"/api/v1/tunnels": map[string]any{
				"get":  operation("listTunnels", "ListTunnelsResponse", nil),
				"post": operation("upsertTunnel", "UpsertTunnelResponse", requestBody("UpsertTunnelRequest")),
				"put":  operation("replaceTunnel", "UpsertTunnelResponse", requestBody("UpsertTunnelRequest")),
			},
			"/api/v1/tunnels/status": map[string]any{
				"get": operation("listTunnelStatuses", "ListTunnelStatusesResponse", nil),
			},
		},
		"components": map[string]any{
			"schemas": map[string]any{
				"ServiceInfo":                 objectSchema(map[string]any{"name": stringSchema(), "type": enumSchema("process", "container", "postgres", "redis", "external"), "status": enumSchema("starting", "running", "failed", "stopped"), "port": integerSchema(), "pid": map[string]any{"type": "integer", "nullable": true}, "url": stringSchema(), "containerId": stringSchema()}, "name", "type", "status", "port"),
				"EnvInfo":                     objectSchema(map[string]any{"envId": stringSchema(), "repoId": stringSchema(), "repoPath": stringSchema(), "branch": stringSchema(), "basePort": integerSchema(), "createdAt": stringSchema(), "services": map[string]any{"type": "array", "items": ref("ServiceInfo")}}, "envId", "repoId", "repoPath", "branch", "basePort", "createdAt", "services"),
				"DaemonInfo":                  objectSchema(map[string]any{"version": stringSchema(), "pid": integerSchema(), "uptime": integerSchema(), "repos": integerSchema(), "activeEnvs": integerSchema()}, "version", "pid", "uptime", "repos", "activeEnvs"),
				"PostgresInstanceInfo":        objectSchema(map[string]any{"version": stringSchema(), "status": enumSchema("running", "stopped", "starting", "error"), "containerId": stringSchema(), "port": integerSchema(), "dataDir": stringSchema(), "databases": map[string]any{"type": "array", "items": stringSchema()}}, "version", "status", "port", "dataDir", "databases"),
				"RedisInstanceInfo":           objectSchema(map[string]any{"status": enumSchema("running", "stopped", "starting", "error"), "containerId": stringSchema(), "port": integerSchema(), "allocatedDbIndices": integerSchema()}, "status", "port", "allocatedDbIndices"),
				"InfraStatusResponse":         objectSchema(map[string]any{"postgres": map[string]any{"type": "array", "items": ref("PostgresInstanceInfo")}, "redis": ref("RedisInstanceInfo")}, "postgres"),
				"CreateEnvRequest":            objectSchema(map[string]any{"repoPath": stringSchema(), "envId": stringSchema(), "prefix": stringSchema(), "envOverrides": map[string]any{"type": "object", "additionalProperties": stringSchema()}, "configFile": stringSchema()}, "repoPath"),
				"CreateEnvResponse":           objectSchema(map[string]any{"env": ref("EnvInfo")}, "env"),
				"GetEnvResponse":              objectSchema(map[string]any{"env": ref("EnvInfo")}, "env"),
				"ListEnvsResponse":            objectSchema(map[string]any{"envs": map[string]any{"type": "array", "items": ref("EnvInfo")}}, "envs"),
				"DeleteEnvResponse":           objectSchema(map[string]any{"ok": booleanSchema()}, "ok"),
				"DownEnvResponse":             objectSchema(map[string]any{"ok": booleanSchema()}, "ok"),
				"LogLine":                     objectSchema(map[string]any{"ts": stringSchema(), "service": stringSchema(), "stream": enumSchema("stdout", "stderr", "system"), "line": stringSchema()}, "ts", "service", "stream", "line"),
				"StopInfraRequest":            objectSchema(map[string]any{"target": enumSchema("postgres", "redis", "all"), "version": stringSchema()}, "target"),
				"StopInfraResponse":           objectSchema(map[string]any{"ok": booleanSchema()}, "ok"),
				"DbTemplate":                  objectSchema(map[string]any{"name": stringSchema(), "size": integerSchema(), "createdAt": stringSchema(), "sourceDatabaseUrl": stringSchema()}, "name", "size", "createdAt"),
				"ListDBTemplatesResponse":     objectSchema(map[string]any{"templates": map[string]any{"type": "array", "items": ref("DbTemplate")}}, "templates"),
				"DumpDBRequest":               objectSchema(map[string]any{"repoPath": stringSchema(), "envId": stringSchema(), "dbName": stringSchema(), "templateName": stringSchema()}, "repoPath", "envId", "dbName", "templateName"),
				"DumpDBResponse":              objectSchema(map[string]any{"template": ref("DbTemplate")}, "template"),
				"RestoreDBRequest":            objectSchema(map[string]any{"repoPath": stringSchema(), "envId": stringSchema(), "dbName": stringSchema(), "templateName": stringSchema()}, "repoPath", "envId", "dbName", "templateName"),
				"RestoreDBResponse":           objectSchema(map[string]any{"ok": booleanSchema()}, "ok"),
				"RegisterRepoRequest":         objectSchema(map[string]any{"repoPath": stringSchema(), "configPath": stringSchema()}, "repoPath", "configPath"),
				"RegisteredRepo":              objectSchema(map[string]any{"repoId": stringSchema(), "repoPath": stringSchema(), "configPath": stringSchema(), "lastSeenAt": stringSchema()}, "repoId", "repoPath", "configPath", "lastSeenAt"),
				"RegisterRepoResponse":        objectSchema(map[string]any{"repo": ref("RegisteredRepo")}, "repo"),
				"ListRegisteredReposResponse": objectSchema(map[string]any{"repos": map[string]any{"type": "array", "items": ref("RegisteredRepo")}}, "repos"),
				"TunnelTarget":                objectSchema(map[string]any{"repoId": stringSchema(), "envId": stringSchema(), "serviceName": stringSchema()}, nil...),
				"TunnelDefinition":            objectSchema(map[string]any{"id": stringSchema(), "provider": stringSchema(), "target": ref("TunnelTarget"), "enabled": booleanSchema(), "config": map[string]any{"type": "object", "additionalProperties": stringSchema()}}, "id", "provider", "target", "enabled"),
				"ListTunnelsResponse":         objectSchema(map[string]any{"tunnels": map[string]any{"type": "array", "items": ref("TunnelDefinition")}}, "tunnels"),
				"UpsertTunnelRequest":         objectSchema(map[string]any{"id": stringSchema(), "provider": stringSchema(), "target": ref("TunnelTarget"), "enabled": booleanSchema(), "config": map[string]any{"type": "object", "additionalProperties": stringSchema()}}, "provider", "target", "enabled"),
				"UpsertTunnelResponse":        objectSchema(map[string]any{"tunnel": ref("TunnelDefinition")}, "tunnel"),
				"TunnelStatusInfo":            objectSchema(map[string]any{"id": stringSchema(), "provider": stringSchema(), "state": stringSchema(), "publicUrl": stringSchema(), "lastError": stringSchema()}, "id", "provider", "state"),
				"ListTunnelStatusesResponse":  objectSchema(map[string]any{"statuses": map[string]any{"type": "array", "items": ref("TunnelStatusInfo")}}, "statuses"),
				"APIError":                    objectSchema(map[string]any{"error": stringSchema(), "code": stringSchema(), "details": map[string]any{}}, "error", "code"),
			},
		},
	}
}

func OpenAPIYAML() []byte {
	out := MustYAML(OpenAPISpec())
	return append(out, '\n')
}

func operation(operationID, responseSchema string, body map[string]any, params ...map[string]any) map[string]any {
	op := map[string]any{
		"operationId": operationID,
		"responses": map[string]any{
			"200": map[string]any{
				"description": "OK",
				"content": map[string]any{
					"application/json": map[string]any{
						"schema": ref(responseSchema),
					},
				},
			},
			"default": map[string]any{
				"description": "Error",
				"content": map[string]any{
					"application/json": map[string]any{
						"schema": ref("APIError"),
					},
				},
			},
		},
	}
	if len(params) > 0 {
		values := make([]any, 0, len(params))
		for _, param := range params {
			values = append(values, param)
		}
		op["parameters"] = values
	}
	if body != nil {
		op["requestBody"] = body
	}
	return op
}

func requestBody(schema string) map[string]any {
	return map[string]any{
		"required": true,
		"content": map[string]any{
			"application/json": map[string]any{
				"schema": ref(schema),
			},
		},
	}
}

func pathParam(name string) map[string]any {
	return map[string]any{
		"name":     name,
		"in":       "path",
		"required": true,
		"schema":   stringSchema(),
	}
}

func ref(name string) map[string]any {
	return map[string]any{"$ref": "#/components/schemas/" + name}
}

func stringSchema() map[string]any {
	return map[string]any{"type": "string"}
}

func integerSchema() map[string]any {
	return map[string]any{"type": "integer"}
}

func booleanSchema() map[string]any {
	return map[string]any{"type": "boolean"}
}

func enumSchema(values ...string) map[string]any {
	items := make([]any, 0, len(values))
	for _, value := range values {
		items = append(items, value)
	}
	return map[string]any{"type": "string", "enum": items}
}

func objectSchema(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{
		"type":       "object",
		"properties": properties,
	}
	if len(required) > 0 {
		items := make([]any, 0, len(required))
		for _, name := range required {
			items = append(items, name)
		}
		schema["required"] = items
	}
	return schema
}
