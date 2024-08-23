import { Probot } from "probot";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const openai = new OpenAI();

export default (app: Probot) => {
  app.on(
    ["pull_request.opened", "pull_request.synchronize"],
    async (context) => {
      const pullRequest = context.payload.pull_request;
      const repo = context.repo();

      // Fetch the pull request files
      const files = await context.octokit.pulls.listFiles({
        ...repo,
        pull_number: pullRequest.number,
      });

      // Analyze the changes (you'll implement your AI logic here)
      const aiReviewComments = await analyzeChanges(files.data);

      // Post comments on the pull request
      await context.octokit.pulls.createReview({
        ...repo,
        pull_number: pullRequest.number,
        body: "ReviewBuddy Comments",
        event: "COMMENT",
        comments: aiReviewComments,
      });
    }
  );
};

interface FileChange {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch?: string;
}

async function analyzeChanges(files: FileChange[]): Promise<any[]> {
  const comments = [];

  for (const file of files) {
    console.log(`Analyzing file: ${file.filename}`);
    console.log(`Status: ${file.status}`);
    console.log(`Additions: ${file.additions}, Deletions: ${file.deletions}`);

    if (file.patch) {
      console.log("Patch:");
      console.log(file.patch);

      const aiSuggestions = await analyzePathWithAI(file.patch);
      if (!aiSuggestions?.length) {
        continue;
      }

      console.log(aiSuggestions);

      for (const suggestion of aiSuggestions) {
        if (!suggestion.message) {
          continue;
        }
        comments.push({
          path: file.filename,
          position: 1, // suggestion.position,
          body: suggestion.message,
        });
      }
    }
  }

  return comments;
}

const Comment = z.object({
  message: z.string().nullable(),
  position: z.number(),
});
const ReviewComments = z.object({
  suggestions: z.array(Comment),
});

async function analyzePathWithAI(patch: string): Promise<
  | {
      message: string | null;
      position: number;
    }[]
  | null
> {
  console.log("Analyzing patch with AI...", patch);

  const chatCompletion = await openai.beta.chat.completions.parse({
    messages: [
      {
        role: "user",
        content: `You are an AI code reviewer and you are given a patch of a file in a GitHub pull request.
          Please review the patch and provide review comments and the relative position from start in the diff where you want to add a review comment.
          You can suggest improvements, point out issues, or provide feedback and you can also provide the changes you want to see in the patch.
          While providing suggestion, it would be helpful if you can provide the code changes you want to see in the patch.
          You can return markdown formatted message.
          If you don't have any suggestion you can return message as null.
          
          Here is the patch:
          ${patch}`,
      },
    ],
    model: "gpt-4o-mini",
    response_format: zodResponseFormat(ReviewComments, "reviewResponse"),
  });

  const message = chatCompletion.choices[0]?.message;

  if (message?.parsed) {
    return message?.parsed.suggestions;
  }

  return null;
}
