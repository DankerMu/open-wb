use std::{env, fs, process};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: candidate <records.json>");
        process::exit(2);
    }
    let input = fs::read_to_string(&args[1]).unwrap_or_else(|error| {
        eprintln!("error: {error}");
        process::exit(1);
    });

    // Intentionally incomplete fixture implementation for the skill evaluation.
    let count = input.matches("\"id\"").count();
    println!("{{\"count\":{count},\"total_cents\":0,\"ids\":[]}}");
}
