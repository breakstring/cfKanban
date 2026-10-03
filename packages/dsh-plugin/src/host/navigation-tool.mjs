export function navigationTool(navigation, defineTool) {
  const targetProperties = {
    instance_id: { type: 'string', required: true, description: 'Exact cfKanban Instance UUID.' },
    workspace_id: { type: 'string', required: true, description: 'Exact cfKanban Workspace UUID.' },
    project_id: { type: 'string', required: true, description: 'Exact cfKanban Project UUID.' },
    identifier: { type: 'string', description: 'Optional exact Issue identifier, for example CFK-123.' },
  };
  const tool = defineTool({
    name: 'cfkanban_view_open',
    description: 'Open the cfKanban sidebar in the calling Agent Session and show an exact Project or Issue. Requires one active foreground DSH client for this Session. Returns opened only after the requested view is rendered. Does not change business data or open a browser. The Host supplies the Session identity.',
    parameters: targetProperties,
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', const: true, required: true }, opened: { type: 'boolean', const: true, required: true }, surface: { type: 'string', const: 'sidebar', required: true }, target: { type: 'object', additionalProperties: false, required: true, properties: targetProperties } } },
          { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', const: false, required: true }, error: { type: 'object', additionalProperties: false, required: true, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } } } },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => navigation.open(args, exec),
  });
  // DSH 的参数 DSL 默认开放根对象；收紧同一 schema 也让 execute 的验证拒绝额外字段。
  tool.parameters.additionalProperties = false;
  return tool;
}
