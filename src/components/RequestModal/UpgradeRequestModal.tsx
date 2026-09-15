import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { Permission } from '@server/lib/permissions';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.RequestModal.UpgradeRequestModal', {
  upgrademovietitle: 'Request Quality Upgrade',
  upgradeseriestitle: 'Request Quality Upgrade',
  upgradeexplainer:
    'This title is already available. An upgrade request asks for a higher quality version to replace the current one.',
  upgradeadmin: 'This upgrade request will be approved automatically.',
  requestupgrade: 'Request Upgrade',
  upgradeSuccess:
    'Upgrade for <strong>{title}</strong> requested successfully!',
  upgradeerror: 'Something went wrong while submitting the upgrade request.',
});

interface UpgradeRequestModalProps {
  tmdbId: number;
  type: 'movie' | 'tv';
  onCancel?: () => void;
  onComplete?: (newStatus: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
}

const UpgradeRequestModal = ({
  tmdbId,
  type,
  onCancel,
  onComplete,
  onUpdating,
}: UpgradeRequestModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const [isUpdating, setIsUpdating] = useState(false);
  const { data, error } = useSWR<MovieDetails | TvDetails>(
    `/api/v1/${type}/${tmdbId}`,
    { revalidateOnMount: true }
  );

  useEffect(() => {
    if (onUpdating) {
      onUpdating(isUpdating);
    }
  }, [isUpdating, onUpdating]);

  const title = data
    ? type === 'movie'
      ? (data as MovieDetails).title
      : (data as TvDetails).name
    : '';

  const hasAutoApprove = hasPermission(
    [
      Permission.MANAGE_REQUESTS,
      Permission.AUTO_APPROVE,
      type === 'movie'
        ? Permission.AUTO_APPROVE_MOVIE
        : Permission.AUTO_APPROVE_TV,
    ],
    { type: 'or' }
  );

  const sendRequest = useCallback(async () => {
    setIsUpdating(true);
    try {
      const response = await axios.post<MediaRequest>('/api/v1/request', {
        mediaId: data?.id,
        mediaType: type,
        tvdbId:
          type === 'tv' ? (data as TvDetails)?.externalIds?.tvdbId : undefined,
        is4k: false,
        isUpgrade: true,
      });
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      mutate('/api/v1/request/count');

      if (response.data) {
        if (onComplete) {
          onComplete(
            hasAutoApprove ? MediaStatus.PROCESSING : MediaStatus.PENDING
          );
        }
        addToast(
          <span>
            {intl.formatMessage(messages.upgradeSuccess, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.upgradeerror), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  }, [data, type, title, hasAutoApprove, onComplete, addToast, intl]);

  return (
    <Modal
      loading={!data && !error}
      backgroundClickable
      onCancel={onCancel}
      onOk={sendRequest}
      okDisabled={isUpdating || !data}
      title={intl.formatMessage(
        type === 'movie'
          ? messages.upgrademovietitle
          : messages.upgradeseriestitle
      )}
      subTitle={title}
      okText={
        isUpdating
          ? intl.formatMessage(globalMessages.requesting)
          : intl.formatMessage(messages.requestupgrade)
      }
      okButtonType="primary"
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    >
      <div className="mt-6">
        <Alert
          title={intl.formatMessage(messages.upgradeexplainer)}
          type="info"
        />
      </div>
      {hasAutoApprove && (
        <div className="mt-4">
          <Alert
            title={intl.formatMessage(messages.upgradeadmin)}
            type="info"
          />
        </div>
      )}
    </Modal>
  );
};

export default UpgradeRequestModal;
