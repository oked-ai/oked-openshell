<!-- oked-openshell: begin -->
## OKed approvals

When an HTTP request is denied with a reason_code that starts with "oked_approval_pending",
a person is reviewing that exact request. Wait 60 seconds, then send the exact same request
again. Keep doing this for up to 10 minutes. Do not change the request.
If the reason_code starts with "oked_denied", stop and tell the user it was denied.
If it starts with "oked_approval_timed_out" or "oked_unavailable", stop and tell the user.
Never try a different way to do the same action.
<!-- oked-openshell: end -->
