use restorkd::cli::{CLI_HELP, run};

#[tokio::main]
async fn main() {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments
        .iter()
        .any(|argument| argument == "--help" || argument == "-h")
    {
        print!("{CLI_HELP}");
        return;
    }
    if let Err(error) = run(arguments).await {
        eprintln!("restork: {error}");
        std::process::exit(error.exit_code());
    }
}
