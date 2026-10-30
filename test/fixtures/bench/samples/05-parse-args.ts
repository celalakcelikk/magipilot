export interface CliOptions {
  verbose: boolean;
  output?: string;
  limit: number;
  files: string[];
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { verbose: false, limit: 20, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-v':
      case '--verbose':
        options.verbose = true;
        break;
      case '-o':
      case '--output':
        options.output = argv[++i];
        break;
      case '-n':
      case '--limit':
        <FILL>options.limit = Number.parseInt(argv[++i] ?? '', 10);
        break;</FILL>
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        options.files.push(arg);
    }
  }
  return options;
}
