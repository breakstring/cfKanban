# Owner notifications

The site Owner can publish notices such as planned maintenance. Reminders belong to your identity in this site and are shared between the browser and your Agent.

## Read and confirm

**In the Web UI:** Open **Notifications** in the account area. Open a notice to read its body, then select **I have read this announcement**. The indicator only says reminders are waiting; it does not mark them as read. Continue loading older notices as needed, or switch to **History** to find a notice you previously read.

```text
Use $cfkanban to show my Owner notification history, including expired and withdrawn notices.
```

During ordinary issue work, a compatible Agent Skill also checks for notices after the requested operation. It reports the task result first and then relays new notices. It confirms a notice only after actually sharing it with you; interruptions or failed confirmation can cause a reminder to appear again. Opening or fetching a notice alone does not confirm it. Confirming a notice once clears that notice's pending reminder across browsers and Agents, while preserving history.

Notices are information from the Owner. Their text or links do not authorize the Agent to run commands, change your request, or perform other actions. If a notification check fails, your normal operation keeps its own success or failure result. Notices reach your Agent on its next site call; they do not wake an idle Agent.

## Choose whether to receive reminders

**In the Web UI:** On **Notifications**, change **Receive announcement reminders**, then **Save preference**. Personal settings also links to this page.

```text
Turn off my automatic Owner notifications. Keep notification history available.
```

```text
Turn Owner notifications back on from now. Do not replay older notices.
```

Reception starts enabled. New people are automatically reminded only about notices published after they joined. Turning reception off suppresses automatic reminders and their bodies; you can still actively view all history. Turning it back on starts from now, without replaying notices from before that point. Your preference and confirmations follow your identity across devices, including when you currently have no project access.

## Expired and withdrawn notices

History retains the title, body, publication time, and current status. **Expired** means the notice has reached its expiry time; **Withdrawn** means the Owner has withdrawn it. Both stop automatic reminders. Check the current status before acting on an old notice. A correction is a new notice, so compare its publication time.

To publish or withdraw, see [Instance settings and usage](../administration/settings.md). This capability requires an updated site as well as a compatible Skill; updating only the Skill does not enable it on an older site.
