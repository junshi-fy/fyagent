import { useRef, useState } from "react";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { ExternalLinkButton } from "../../shared/features/controls/ExternalLinkButton";
import { useAppVersion } from "../../shared/features/useAppVersion";
import { Button, IconButton } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import type { DialogOriginRef } from "../../shared/ui/dialogOrigin";
import {
  ABOUT_COPY,
  PROJECT_URL,
  buildFeedbackUrl,
  dismissStarPrompt,
  readStarPromptDismissed,
} from "./aboutDialogState";
import "./about-dialog.css";

export default function AboutDialog({
  open,
  onOpenChange,
  originRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originRef: DialogOriginRef;
}) {
  const version = useAppVersion(open);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [starDismissed, setStarDismissed] = useState(readStarPromptDismissed);
  const copy = ABOUT_COPY;
  const feedbackUrl = buildFeedbackUrl({
    version: version.data,
  });

  const handleDismissStar = () => {
    setStarDismissed(true);
    dismissStarPrompt();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      originRef={originRef}
      initialFocusRef={closeRef}
      title={copy.title}
      description={copy.description}
      actions={
        <Button ref={closeRef} onClick={() => onOpenChange(false)}>
          {copy.close}
        </Button>
      }
    >
      <div className="fy-about-content">
        {!starDismissed && (
          <div className="fy-about-star-banner">
            <div className="fy-about-star-banner-content">
              <StarIcon
                size={18}
                weight="fill"
                aria-hidden="true"
                className="fy-about-star-icon"
              />
              <p className="fy-about-star-text">{copy.starPrompt}</p>
            </div>
            <div className="fy-about-star-actions">
              <ExternalLinkButton url={PROJECT_URL}>
                <GithubLogoIcon size={16} aria-hidden="true" />
                <span>{copy.starButton}</span>
              </ExternalLinkButton>
              <IconButton
                className="fy-about-star-dismiss"
                onClick={handleDismissStar}
                aria-label={copy.dismissStarPrompt}
                title={copy.dismissStarPrompt}
              >
                <XIcon size={16} aria-hidden="true" />
              </IconButton>
            </div>
          </div>
        )}
        <div className="fy-about-version" aria-live="polite">
          <span>{copy.currentVersion}</span>
          {version.data ? (
            <strong>{version.data}</strong>
          ) : version.isError ? (
            <>
              <span>{copy.versionUnavailable}</span>
              <Button
                onClick={() => void version.refetch()}
                disabled={version.isFetching}
              >
                {version.isFetching ? copy.loading : copy.reload}
              </Button>
            </>
          ) : (
            <span>{copy.loading}</span>
          )}
        </div>
        <div className="fy-about-links">
          <ExternalLinkButton url={`${PROJECT_URL}/releases`}>
            {copy.checkUpdates}
          </ExternalLinkButton>
          <ExternalLinkButton url={`${PROJECT_URL}/issues`}>
            {copy.helpAndFeedback}
          </ExternalLinkButton>
          <ExternalLinkButton url={feedbackUrl}>
            {copy.feedback}
          </ExternalLinkButton>
        </div>
        <details className="fy-about-details">
          <summary>{copy.releaseAndLicense}</summary>
          <p>{copy.releaseDescription}</p>
          <div className="fy-about-links">
            <ExternalLinkButton url={PROJECT_URL}>
              {copy.projectHome}
            </ExternalLinkButton>
            <ExternalLinkButton url={`${PROJECT_URL}/blob/main/LICENSING.md`}>
              {copy.softwareLicense}
            </ExternalLinkButton>
            <ExternalLinkButton
              url={`${PROJECT_URL}/blob/main/THIRD_PARTY_NOTICES.md`}
            >
              {copy.thirdPartyNotices}
            </ExternalLinkButton>
          </div>
        </details>
      </div>
    </Dialog>
  );
}
