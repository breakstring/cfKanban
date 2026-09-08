interface ContainerChoice {
  id: string;
  name: string;
  workspaceName?: string;
}

export function containerChoiceLabels(choices: ContainerChoice[]): Map<string, { label: string; title?: string }> {
  const groups = new Map<string, Set<string>>();
  for (const choice of choices) {
    const key = JSON.stringify([choice.workspaceName ?? null, choice.name]);
    const ids = groups.get(key) ?? new Set<string>();
    ids.add(choice.id);
    groups.set(key, ids);
  }
  return new Map(choices.map((choice) => {
    const collision = (groups.get(JSON.stringify([choice.workspaceName ?? null, choice.name]))?.size ?? 0) > 1;
    const name = choice.workspaceName === undefined ? choice.name : `${choice.workspaceName} / ${choice.name}`;
    return [choice.id, collision ? { label: `${name} (${choice.id.slice(-8)})`, title: choice.id } : { label: name }];
  }));
}
