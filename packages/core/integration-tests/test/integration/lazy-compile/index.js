async function main() {
    const m = await import('./lazy-1');
    await import('./parallel-lazy-1');
    return 'sup'; //m.default();
}

main();