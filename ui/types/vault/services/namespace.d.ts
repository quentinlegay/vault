/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: BUSL-1.1
 */

import Service from '@ember/service';

interface PathsResponse {
  [key: string]: {
    capabilities: string[];
  };
}
export default class NamespaceService extends Service {
  userRootNamespace: string;
  inRootNamespace: boolean;
  inHvdAdminNamespace: boolean;
  currentNamespace: string;
  relativeNamespace: string;
  path: string;
  setNamespace: () => void;
  findNamespacesForUser: () => void;
  reset: () => void;
}
