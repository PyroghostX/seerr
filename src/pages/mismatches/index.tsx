import AvailabilityMismatchList from '@app/components/AvailabilityMismatchList';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const MismatchesPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <AvailabilityMismatchList />;
};

export default MismatchesPage;
