const environment = Object.fromEntries(
	Object.entries(process.env).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	),
);

process.stdout.write(`${JSON.stringify({ environment })}\n`);
