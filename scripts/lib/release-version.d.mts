export function readReleaseVersion(repositoryRoot: string): Promise<string>;
export function writeBuildVersion(options: { repositoryRoot: string; outputDirectory: string; entry: string; version: string }): Promise<void>;
export function verifyBuildVersion(options: { outputDirectory: string; entry: string; version: string }): Promise<void>;
export function verifyReleaseBuild(options: { repositoryRoot: string; version: string }): Promise<void>;
