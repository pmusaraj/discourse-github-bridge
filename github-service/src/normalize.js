export function normalizeGitHubWebhook({ eventName, deliveryId, payload }) {
  if (!deliveryId) {
    throw new Error("deliveryId is required");
  }

  if (
    ![
      "pull_request",
      "pull_request_review",
      "issue_comment",
      "check_run",
      "check_suite"
    ].includes(eventName)
  ) {
    throw new Error(`unsupported event: ${eventName}`);
  }

  return {
    event_id: deliveryId,
    event_type: eventName,
    action: payload.action,
    repository: payload.repository,
    pull_request: payload.pull_request,
    review: payload.review,
    issue: payload.issue,
    comment: payload.comment,
    check_run: payload.check_run,
    check_suite: payload.check_suite
  };
}
