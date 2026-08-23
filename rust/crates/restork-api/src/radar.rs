//! Fixed-query public project discovery for Radar.

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

use super::agent_tools::collect_verified_x_posts;
use super::{sha256_hex, state::ApiState};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RadarConfiguration {
    pub(super) enabled: bool,
    #[serde(default)]
    pub(super) github_discovery: bool,
    /// Accepted only to migrate pre-alpha clients from personal Stars to the public feed.
    #[serde(default)]
    pub(super) github_user: Option<String>,
    #[serde(default)]
    pub(super) hacker_news: bool,
    #[serde(default)]
    pub(super) x_search: bool,
    #[serde(default)]
    pub(super) x_topics: String,
}

pub(super) struct NewRadarOwned {
    pub(super) item_id: String,
    pub(super) lane: String,
    pub(super) title: String,
    pub(super) source: String,
    pub(super) url: String,
    pub(super) summary: String,
    pub(super) score: f64,
    pub(super) stars_total: Option<i64>,
    pub(super) published_at: Option<String>,
}

pub(super) fn github_discovery_urls(now: DateTime<Utc>) -> Vec<url::Url> {
    let active_since = (now - Duration::days(30)).format("%Y-%m-%d").to_string();
    ["ai-agents", "mcp", "agent-framework"]
        .into_iter()
        .map(|topic| {
            let mut url = url::Url::parse("https://api.github.com/search/repositories")
                .expect("fixed GitHub Search endpoint");
            url.query_pairs_mut()
                .append_pair(
                    "q",
                    &format!("topic:{topic} pushed:>={active_since} stars:>=20"),
                )
                .append_pair("sort", "stars")
                .append_pair("order", "desc")
                .append_pair("per_page", "20");
            url
        })
        .collect()
}

pub(super) fn github_radar_record(item: &Value) -> Option<NewRadarOwned> {
    if item["archived"].as_bool() == Some(true) || item["fork"].as_bool() == Some(true) {
        return None;
    }
    let repository = item["full_name"].as_str()?;
    let url = item["html_url"].as_str()?;
    let relevance = github_repository_relevance(item);
    if relevance < 20 {
        return None;
    }
    let stars = item["stargazers_count"].as_u64().unwrap_or(0);
    let description = item["description"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("No repository description provided.");
    let language = item["language"].as_str().unwrap_or("mixed");
    Some(NewRadarOwned {
        item_id: format!("github-{}", &sha256_hex(repository.as_bytes())[..24]),
        lane: "trending".to_owned(),
        title: repository.to_owned(),
        source: "GitHub · public AI/Agent discovery".to_owned(),
        url: url.to_owned(),
        summary: format!("{description} · {language}"),
        score: f64::from(relevance) * 100_000.0 + stars.min(99_999) as f64,
        stars_total: Some(i64::try_from(stars).unwrap_or(i64::MAX)),
        published_at: item["pushed_at"].as_str().map(ToOwned::to_owned),
    })
}

pub(super) async fn verified_x_radar_records(
    topics: &str,
    now: DateTime<Utc>,
) -> Result<Vec<NewRadarOwned>, String> {
    let query = format!(
        "Find up to 12 recent public X posts from the last 24 hours about these topics: {topics}. Prefer original posts from official project accounts and firsthand technical discussion. Return only exact posts you find."
    );
    collect_verified_x_posts(&query).await.map(|posts| {
        posts
            .into_iter()
            .take(12)
            .map(|post| {
                let score = post
                    .posted_at
                    .as_deref()
                    .and_then(|value| value.parse::<DateTime<Utc>>().ok())
                    .map_or_else(|| now.timestamp() as f64, |value| value.timestamp() as f64);
                NewRadarOwned {
                    item_id: format!("x-{}", post.post_id),
                    lane: "x".to_owned(),
                    title: format!("@{}", post.author_handle),
                    source: "X · independently verified".to_owned(),
                    url: post.post_url,
                    summary: post.text_excerpt,
                    score,
                    stars_total: None,
                    published_at: post.posted_at,
                }
            })
            .collect()
    })
}

pub(super) fn bootstrap_radar(state: &ApiState) -> Result<Option<Value>, ()> {
    let storage = state.storage.as_ref().ok_or(())?;
    let configured = storage
        .daily_cache("radar-config")
        .map_err(|_| ())?
        .is_some_and(|record| record.payload["enabled"].as_bool() == Some(true));
    if !configured {
        return Ok(None);
    }
    // GitHub star totals and Hacker News scores are not comparable. Keep the
    // complete bounded refresh set in bootstrap so one high-scoring lane
    // cannot make another configured lane look empty on first paint.
    let items = storage.radar_items(50, 0).map_err(|_| ())?;
    Ok(Some(json!({"configured": true, "items": items})))
}

fn github_repository_relevance(item: &Value) -> u32 {
    let mut score = 0_u32;
    let mut text = format!(
        "{} {}",
        item["name"].as_str().unwrap_or_default(),
        item["description"].as_str().unwrap_or_default()
    )
    .to_ascii_lowercase();
    let topics = item["topics"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    for topic in &topics {
        text.push(' ');
        text.push_str(topic);
    }
    for keyword in [
        "ai-agent",
        "ai agent",
        "agent-framework",
        "agent framework",
        "agentic",
        "autonomous agent",
        "mcp",
        "model context protocol",
        "llm",
        "large language model",
        "rag",
        "copilot",
        "claude code",
        "codex",
    ] {
        if text.contains(keyword) {
            score = score.saturating_add(12);
        }
    }
    let topic_score = u32::try_from(
        topics
            .iter()
            .filter(|topic| {
                matches!(
                    topic.as_str(),
                    "ai-agents"
                        | "agent-framework"
                        | "autonomous-agents"
                        | "mcp"
                        | "model-context-protocol"
                        | "llm"
                        | "rag"
                        | "generative-ai"
                )
            })
            .count()
            .saturating_mul(16),
    )
    .unwrap_or(0);
    score.saturating_add(topic_score)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn github_queries_are_fixed_bounded_and_recent() {
        let now = DateTime::parse_from_rfc3339("2026-08-08T10:00:00Z")
            .expect("fixed time")
            .with_timezone(&Utc);
        let urls = github_discovery_urls(now);
        assert_eq!(urls.len(), 3);
        for url in urls {
            assert_eq!(url.host_str(), Some("api.github.com"));
            assert_eq!(url.path(), "/search/repositories");
            let query = url.query().expect("query");
            assert!(query.contains("pushed%3A%3E%3D2026-07-09"));
            assert!(query.contains("stars%3A%3E%3D20"));
            assert!(query.contains("per_page=20"));
        }
    }

    #[test]
    fn relevant_projects_are_kept_and_archives_are_rejected() {
        let active = json!({
            "name": "agent-runtime",
            "full_name": "example/agent-runtime",
            "html_url": "https://github.com/example/agent-runtime",
            "description": "A secure MCP runtime for AI agents",
            "topics": ["ai-agents", "mcp"],
            "stargazers_count": 4200,
            "language": "Rust",
            "pushed_at": "2026-08-08T00:00:00Z",
            "archived": false,
            "fork": false
        });
        let record = github_radar_record(&active).expect("relevant repository");
        assert_eq!(record.lane, "trending");
        assert_eq!(record.stars_total, Some(4200));
        assert!(record.summary.ends_with("· Rust"));

        let mut archived = active;
        archived["archived"] = json!(true);
        assert!(github_radar_record(&archived).is_none());
    }
}
