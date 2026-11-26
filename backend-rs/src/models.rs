use crate::util::new_id;
use serde::{Deserialize, Serialize};

fn one() -> f64 {
    1.0
}
fn scale() -> String {
    "scale".to_string()
}
fn three() -> i64 {
    3
}
fn four() -> i64 {
    4
}
fn ten() -> f64 {
    10.0
}
fn default_period() -> String {
    "monthly".to_string()
}
fn all_channel() -> String {
    "all".to_string()
}
fn yes() -> bool {
    true
}
fn scheduled() -> String {
    "scheduled".to_string()
}
fn completed() -> String {
    "completed".to_string()
}
fn pass_mark() -> i64 {
    70
}
fn five() -> i64 {
    5
}

// ---------- users ----------

#[derive(Debug, Clone, Deserialize)]
pub struct CreateUserIn {
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default = "default_role")]
    pub role: String,
    #[serde(default)]
    pub password: Option<String>,
}

fn default_role() -> String {
    "agent".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResetPasswordIn {
    pub new_password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StatusIn {
    pub disabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChangePasswordIn {
    #[serde(default)]
    pub current_password: Option<String>,
    pub new_password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RoleIn {
    pub role: String,
}

// ---------- QA forms ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Criterion {
    #[serde(default = "new_id")]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "one")]
    pub weight: f64,
    #[serde(default = "scale", rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub auto_fail: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormIn {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "all_channel")]
    pub channel: String,
    #[serde(default)]
    pub criteria: Vec<Criterion>,
}

// ---------- interactions / disputes / calibration ----------

#[derive(Debug, Clone, Deserialize)]
pub struct DisputeIn {
    pub reason: String,
    #[serde(default)]
    pub criterion_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResolveIn {
    pub decision: String,
    #[serde(default)]
    pub new_score: Option<f64>,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimedNote {
    #[serde(default)]
    pub t: f64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SelfReviewIn {
    #[serde(default)]
    pub reflection: String,
    #[serde(default)]
    pub notes: Vec<TimedNote>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CalibrationIn {
    pub interaction_id: String,
    #[serde(default)]
    pub title: String,
    pub participant_ids: Vec<String>,
    #[serde(default)]
    pub due: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CritScore {
    pub id: String,
    pub score: f64,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CalScoreIn {
    pub criteria: Vec<CritScore>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CalCloseIn {
    pub criteria: Vec<CritScore>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub apply_to_interaction: bool,
}

// ---------- knowledge base ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub image_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ArticleIn {
    pub title: String,
    pub category: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "yes")]
    pub self_service: bool,
    #[serde(default)]
    pub review_date: String,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub allowed_roles: Vec<String>,
    #[serde(default)]
    pub review_note: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AskIn {
    pub question: String,
}

// ---------- decision trees ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeOption {
    pub label: String,
    #[serde(default)]
    pub next: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeNode {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub script: String,
    #[serde(default)]
    pub options: Vec<TreeOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeIn {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    pub start_node: String,
    pub nodes: Vec<TreeNode>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GenTreeIn {
    pub title: String,
    pub sop: String,
}

// ---------- training ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lesson {
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub article_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuizQ {
    pub question: String,
    pub options: Vec<String>,
    pub answer_index: i64,
    #[serde(default)]
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CourseIn {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default = "pass_mark")]
    pub pass_mark: i64,
    #[serde(default)]
    pub lessons: Vec<Lesson>,
    #[serde(default)]
    pub quiz: Vec<QuizQ>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GenQuizIn {
    pub content: String,
    #[serde(default = "five")]
    pub count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AttemptIn {
    pub answers: Vec<i64>,
}

// ---------- coaching ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub text: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CoachingIn {
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub agent_name: String,
    #[serde(default)]
    pub interaction_id: String,
    #[serde(default)]
    pub scheduled_for: String,
    pub focus: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "scheduled")]
    pub status: String,
    #[serde(default)]
    pub action_items: Vec<ActionItem>,
    #[serde(default)]
    pub article_ids: Vec<String>,
    #[serde(default)]
    pub course_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ItemToggle {
    pub done: bool,
}

// ---------- QA operations ----------

#[derive(Debug, Clone, Deserialize)]
pub struct PolicyIn {
    pub name: String,
    #[serde(default = "all_channel")]
    pub channel: String,
    #[serde(default)]
    pub form_id: String,
    #[serde(default = "default_period")]
    pub period: String,
    #[serde(default = "four")]
    pub target_per_agent: i64,
    #[serde(default = "ten")]
    pub sample_percent: f64,
    #[serde(default = "three")]
    pub sla_days: i64,
    #[serde(default = "yes")]
    pub include_flagged: bool,
    #[serde(default = "yes")]
    pub include_auto_fail: bool,
    #[serde(default = "yes")]
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunPolicyIn {
    pub policy_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssignmentIn {
    pub interaction_id: String,
    #[serde(default)]
    pub evaluator_id: String,
    #[serde(default = "three")]
    pub sla_days: i64,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompleteIn {
    #[serde(default = "completed")]
    pub status: String,
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub note: String,
}

// ---------- knowledge governance ----------

#[derive(Debug, Clone, Deserialize)]
pub struct NoteIn {
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewerIn {
    #[serde(default)]
    pub reviewer_id: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FeedbackIn {
    pub helpful: bool,
    #[serde(default)]
    pub comment: String,
}

// ---------- auth / integrations ----------

#[derive(Debug, Clone, Deserialize)]
pub struct LdapLogin {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LdapConfigIn {
    pub url: String,
    pub base_dn: String,
    #[serde(default)]
    pub bind_dn: String,
    #[serde(default)]
    pub bind_password: Option<String>,
    #[serde(default)]
    pub user_filter: String,
    #[serde(default)]
    pub team_lead_group_dn: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LdapTestIn {
    pub url: String,
    pub base_dn: String,
    #[serde(default)]
    pub bind_dn: String,
    #[serde(default)]
    pub bind_password: Option<String>,
    #[serde(default)]
    pub user_filter: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SmtpConfigIn {
    pub host: String,
    #[serde(default = "smtp_port")]
    pub port: u16,
    #[serde(default = "starttls")]
    pub security: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    pub from_address: String,
}

fn smtp_port() -> u16 {
    587
}
fn starttls() -> String {
    "starttls".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct SmtpTestIn {
    pub host: String,
    #[serde(default = "smtp_port")]
    pub port: u16,
    #[serde(default = "starttls")]
    pub security: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    pub from_address: String,
    pub recipient: String,
}
